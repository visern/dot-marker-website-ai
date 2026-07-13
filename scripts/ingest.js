#!/usr/bin/env node
// Builds the RAG knowledge base from knowledge/ and writes it to data/.
// Re-run this whenever knowledge/ changes (or just redeploy — Vercel runs
// this automatically as the build command, see vercel.json).
//
// knowledge/products.json  -> copied verbatim to data/products.json (facts,
//                              never embedded — read directly by api/chat.js)
// knowledge/books/*.md      -> one chunk per file, embedded (narrative)
// knowledge/site/*.md       -> one chunk per file, embedded (narrative)
// knowledge/pdfs/*.pdf      -> one chunk per page, embedded (page-level facts).
//                              Pages with a real text layer are read directly;
//                              image-only pages are rendered to PNG and OCR'd.
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { createWorker } = require('tesseract.js');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_EMBED_MODEL = 'gemini-embedding-001';
const EMBED_BATCH_SIZE = 90;

const KNOWLEDGE_DIR = path.join(__dirname, '..', 'knowledge');
const DATA_DIR = path.join(__dirname, '..', 'data');

// Books whose interior PDF has a real text layer we can read directly.
// Anything not listed here falls back to OCR (see ocrPdfPages below).
const TEXT_LAYER_BOOKS = {
  abc: 'dot-markers-abc_interior.pdf',
  animals: 'dot-markers-animals_interior.pdf',
};
const OCR_BOOKS = {
  jungle: 'dot-markers-animals-vol-2_interior.pdf',
};

// OCR on this book's cursive-font captions gets ~85% of pages right
// automatically; these specific pages were manually checked against the
// actual rendered page (not guessed) and corrected. Re-verify against the
// real page before editing this list if dot-markers-animals-vol-2_interior.pdf ever changes.
const OCR_CORRECTIONS = {
  jungle: {
    19: 'Lemur', // OCR read "Lemar"
    23: 'Sloth', // OCR truncated to "S"
    31: 'Aardvark', // OCR truncated to "A"
    45: 'Pufferfish', // OCR read "5 Pusfergish"
    77: 'Pufferfish', // duplicate Pufferfish page later in the book; OCR read "5 Pusfergish"
    85: 'Flying Squirrel', // OCR truncated to "Fly"
    95: 'Galapagos Tortoise', // caption wraps to a 2nd line OCR didn't reach; OCR read "Galapagos"
    105: 'Shih Tzu Dog', // OCR found no text on this page at all
  },
};

function readMarkdownChunks(subdir, source) {
  const dir = path.join(KNOWLEDGE_DIR, subdir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((filename) => {
      const text = fs.readFileSync(path.join(dir, filename), 'utf8').trim();
      const headingMatch = text.match(/^#\s+(.+)$/m);
      const title = headingMatch ? headingMatch[1].trim() : filename.replace(/\.md$/, '');
      return {
        id: `${source}-${filename.replace(/\.md$/, '')}`,
        source,
        title,
        text,
      };
    });
}

async function textLayerPdfChunks(bookId, filename) {
  const filePath = path.join(KNOWLEDGE_DIR, 'pdfs', filename);
  const buf = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: buf });
  const result = await parser.getText();
  await parser.destroy();

  const pages = result.text.split(/-- (\d+) of \d+ --/).slice(1);
  const chunks = [];
  for (let i = 0; i < pages.length; i += 2) {
    const pageNum = Number(pages[i]);
    const pageText = pages[i + 1].trim();
    if (!pageText) continue;
    chunks.push({
      id: `pdf-${bookId}-page-${pageNum}`,
      source: 'pdf',
      book: bookId,
      page: pageNum,
      title: `${bookId} book — page ${pageNum}`,
      text: `Page ${pageNum} of the ${bookId} book features: ${pageText}`,
    });
  }
  return chunks;
}

// Image-only pages (e.g. Canva-exported activity pages with no embedded text):
// render each page to PNG and OCR it. The caption is always the first line;
// everything after it is OCR noise from the line-art illustration, so we
// discard all but the first line.
async function ocrPdfChunks(bookId, filename) {
  const filePath = path.join(KNOWLEDGE_DIR, 'pdfs', filename);
  const buf = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: buf });
  const info = await parser.getInfo();
  const totalPages = info.total;

  const langPath = path.join(__dirname, '..', 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int');
  const worker = await createWorker('eng', 1, { langPath, gzip: true });

  // A quick pixel check on just the caption band (top of the page) is enough
  // to detect the blank spacer pages that alternate with content pages in
  // this book, without needing to OCR them at all. Tried gating the actual
  // OCR pass on a tighter crop + single-line mode too, expecting the
  // illustration below the caption to be pure noise — in practice it made
  // recognition worse on more pages than it fixed (clipped ascenders/
  // descenders on this cursive font), so OCR runs on the full page with
  // default settings; only the blank-page pre-check uses the crop.
  const CAPTION_BAND_FRACTION = 0.22;
  const BLANK_PAGE_THRESHOLD = 0.005;

  function nonWhiteFraction(canvas) {
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let nonWhite = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) nonWhite++;
    }
    return nonWhite / (canvas.width * canvas.height);
  }

  const corrections = OCR_CORRECTIONS[bookId] || {};
  const chunks = [];
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const screenshot = await parser.getScreenshot({ partial: [pageNum], scale: 2 });
    const page = screenshot.pages[0];
    const img = await loadImage(Buffer.from(page.data));

    const cropHeight = Math.round(img.height * CAPTION_BAND_FRACTION);
    const captionBand = createCanvas(img.width, cropHeight);
    captionBand.getContext('2d').drawImage(img, 0, 0, img.width, cropHeight, 0, 0, img.width, cropHeight);
    if (nonWhiteFraction(captionBand) < BLANK_PAGE_THRESHOLD) continue; // blank/spacer page — skip OCR entirely

    let firstLine;
    if (corrections[pageNum]) {
      firstLine = corrections[pageNum];
      console.log(`  page ${pageNum}/${totalPages}: "${firstLine}" (manually corrected)`);
    } else {
      const { data } = await worker.recognize(Buffer.from(page.data));
      const rawFirstLine = data.text.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
      if (!rawFirstLine) continue; // content page but nothing recognizable, and no correction on file
      // Strip stray leading punctuation/symbol noise Tesseract sometimes adds
      // before the real caption (e.g. "| Sea Otter" -> "Sea Otter").
      firstLine = rawFirstLine.replace(/^[^A-Za-z0-9]+/, '').trim() || rawFirstLine;
      console.log(`  OCR'd page ${pageNum}/${totalPages}: "${firstLine}"`);
    }

    chunks.push({
      id: `pdf-${bookId}-page-${pageNum}`,
      source: 'pdf',
      book: bookId,
      page: pageNum,
      title: `${bookId} book — page ${pageNum}`,
      text: `Page ${pageNum} of the ${bookId} book features: ${firstLine}`,
    });
  }

  await worker.terminate();
  await parser.destroy();
  return chunks;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Google's free-tier embedding quota is per-minute, and appears to count
// each item inside a batchEmbedContents call toward it (not just the API
// call itself) - so sending batches back-to-back can exceed it even though
// each individual call is well under the batch size limit. On a 429, Google
// tells us exactly how long to wait via RetryInfo.retryDelay; honor that
// (with a sane fallback) instead of failing the whole build.
const MAX_EMBED_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 60_000;

async function embedBatch(texts, attempt = 1) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:batchEmbedContents`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({
      requests: texts.map((text) => ({
        model: `models/${GEMINI_EMBED_MODEL}`,
        content: { parts: [{ text }] },
        taskType: 'RETRIEVAL_DOCUMENT',
      })),
    }),
  });

  if (res.status === 429 && attempt < MAX_EMBED_RETRIES) {
    const body = await res.text();
    let delayMs = DEFAULT_RETRY_DELAY_MS;
    const match = body.match(/"retryDelay":\s*"(\d+)s"/);
    if (match) delayMs = Number(match[1]) * 1000 + 2000; // pad 2s past what Google asked for
    console.log(`  Rate limited embedding batch (attempt ${attempt}/${MAX_EMBED_RETRIES}), waiting ${Math.round(delayMs / 1000)}s...`);
    await sleep(delayMs);
    return embedBatch(texts, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.embeddings.map((e) => e.values);
}

async function embedAll(chunks) {
  const embeddings = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    console.log(`Embedding chunks ${i + 1}-${i + batch.length} of ${chunks.length}...`);
    const texts = batch.map((c) => `${c.title}\n${c.text}`);
    embeddings.push(...(await embedBatch(texts)));
    // Pace ourselves between batches so consecutive batches don't cumulatively
    // exceed the free tier's per-minute quota even without hitting a 429 first.
    if (i + EMBED_BATCH_SIZE < chunks.length) await sleep(65_000);
  }
  return embeddings;
}

async function main() {
  if (!GEMINI_API_KEY) {
    console.error('Missing GEMINI_API_KEY environment variable.');
    process.exit(1);
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Facts: copied verbatim, never embedded.
  const products = JSON.parse(fs.readFileSync(path.join(KNOWLEDGE_DIR, 'products.json'), 'utf8'));
  fs.writeFileSync(path.join(DATA_DIR, 'products.json'), JSON.stringify(products, null, 2));
  console.log(`Copied ${products.length} products to data/products.json`);

  // Narrative: one chunk per markdown file.
  const chunks = [
    ...readMarkdownChunks('books', 'book'),
    ...readMarkdownChunks('site', 'site'),
  ];

  // PDF interiors: one chunk per page.
  for (const [bookId, filename] of Object.entries(TEXT_LAYER_BOOKS)) {
    console.log(`Extracting text from ${filename}...`);
    chunks.push(...(await textLayerPdfChunks(bookId, filename)));
  }
  for (const [bookId, filename] of Object.entries(OCR_BOOKS)) {
    console.log(`OCR'ing ${filename} (this takes a few minutes)...`);
    chunks.push(...(await ocrPdfChunks(bookId, filename)));
  }

  console.log(`Embedding ${chunks.length} chunks with ${GEMINI_EMBED_MODEL}...`);
  const embeddings = await embedAll(chunks);

  const records = chunks.map((chunk, i) => ({ ...chunk, embedding: embeddings[i] }));
  fs.writeFileSync(
    path.join(DATA_DIR, 'embeddings.json'),
    JSON.stringify({ model: GEMINI_EMBED_MODEL, records }, null, 2)
  );
  console.log(`Wrote ${records.length} embeddings to data/embeddings.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
