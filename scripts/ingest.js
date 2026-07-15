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
const GROQ_EMBED_MODEL = 'nomic-embed-text-v1_5';

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
  const texts = chunks.map((c) => `${c.title}\n${c.text}`);
  const res = await fetch('https://api.groq.com/openai/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model: GROQ_EMBED_MODEL, input: texts }),
  });

  if ((res.status === 429 || res.status === 503) && attempt < MAX_EMBED_RETRIES) {
    console.log(`  Rate limited/unavailable embedding batch (attempt ${attempt}/${MAX_EMBED_RETRIES}), waiting ${RETRY_DELAY_MS / 1000}s...`);
    await sleep(RETRY_DELAY_MS);
    return embedAll(chunks, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`Groq API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  // Groq returns each embedding tagged with its input index, not necessarily
  // in request order, so sort back into request order before zipping with chunks.
  return data.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((e) => e.embedding);
}

async function main() {
  if (!GROQ_API_KEY) {
    console.error('Missing GROQ_API_KEY environment variable.');
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

  console.log(`Embedding ${chunks.length} chunks with ${GROQ_EMBED_MODEL}...`);
  const embeddings = await embedAll(chunks);

  const records = chunks.map((chunk, i) => ({ ...chunk, embedding: embeddings[i] }));
  fs.writeFileSync(
    path.join(DATA_DIR, 'embeddings.json'),
    JSON.stringify({ model: GROQ_EMBED_MODEL, records }, null, 2)
  );
  console.log(`Wrote ${records.length} embeddings to data/embeddings.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
