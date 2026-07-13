#!/usr/bin/env node
// Builds the RAG knowledge base from knowledge/ and writes it to data/.
// Re-run this whenever knowledge/ changes (or just redeploy — Vercel runs
// this automatically as the build command, see vercel.json).
//
// knowledge/products.json  -> copied verbatim to data/products.json (facts,
//                              never embedded — read directly by api/chat.js)
// knowledge/books/*.md      -> one chunk per file, embedded (narrative)
// knowledge/site/*.md       -> one chunk per file, embedded (narrative)
const fs = require('fs');
const path = require('path');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_EMBED_MODEL = 'gemini-embedding-001';
const EMBED_BATCH_SIZE = 90;

const KNOWLEDGE_DIR = path.join(__dirname, '..', 'knowledge');
const DATA_DIR = path.join(__dirname, '..', 'data');

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
