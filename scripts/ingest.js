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

const GROQ_API_KEY = process.env.GROQ_API_KEY;
// Groq has no embeddings API (verified against their model list, docs, and
// pricing page — text generation/speech only), so embeddings use Gemini
// while Groq stays the chat generation provider (see api/chat.js).
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_EMBED_MODEL = 'gemini-embedding-001';

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
const MAX_EMBED_RETRIES = 5;
const RETRY_DELAY_MS = 5_000;

async function embedAll(chunks, attempt = 1) {
  const requests = chunks.map((c) => ({
    model: `models/${GEMINI_EMBED_MODEL}`,
    content: { parts: [{ text: `${c.title}\n${c.text}` }] },
    taskType: 'RETRIEVAL_DOCUMENT',
  }));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:batchEmbedContents`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({ requests }),
  });

  if ((res.status === 429 || res.status === 503) && attempt < MAX_EMBED_RETRIES) {
    console.log(`  Rate limited/unavailable embedding batch (attempt ${attempt}/${MAX_EMBED_RETRIES}), waiting ${RETRY_DELAY_MS / 1000}s...`);
    await sleep(RETRY_DELAY_MS);
    return embedAll(chunks, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.embeddings.map((e) => e.values);
}

async function main() {
  if (!GROQ_API_KEY) {
    console.error('Missing GROQ_API_KEY environment variable.');
    process.exit(1);
  }
  if (!GEMINI_API_KEY) {
    console.error('Missing GEMINI_API_KEY environment variable (used for embeddings — Groq has no embeddings API).');
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
