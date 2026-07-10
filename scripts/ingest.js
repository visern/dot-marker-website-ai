#!/usr/bin/env node
// Embeds content/knowledge.json chunks with the Gemini API and writes data/embeddings.json.
// Re-run this whenever content/knowledge.json changes (or just redeploy — Vercel runs
// this automatically as the build command, see vercel.json).
const fs = require('fs');
const path = require('path');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_EMBED_MODEL = 'gemini-embedding-001';

const KNOWLEDGE_PATH = path.join(__dirname, '..', 'content', 'knowledge.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'embeddings.json');

async function embedBatch(texts) {
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
  if (!res.ok) {
    throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.embeddings.map((e) => e.values);
}

async function main() {
  if (!GEMINI_API_KEY) {
    console.error('Missing GEMINI_API_KEY environment variable.');
    process.exit(1);
  }

  const chunks = JSON.parse(fs.readFileSync(KNOWLEDGE_PATH, 'utf8'));
  const texts = chunks.map((c) => `${c.title}\n${c.text}`);

  console.log(`Embedding ${chunks.length} chunks with ${GEMINI_EMBED_MODEL}...`);
  const embeddings = await embedBatch(texts);

  const records = chunks.map((chunk, i) => ({
    id: chunk.id,
    title: chunk.title,
    text: chunk.text,
    embedding: embeddings[i],
  }));

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ model: GEMINI_EMBED_MODEL, records }, null, 2));
  console.log(`Wrote ${records.length} embeddings to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
