#!/usr/bin/env node
// Embeds content/knowledge.json chunks with Voyage AI and writes data/embeddings.json.
// Re-run this whenever content/knowledge.json changes.
const fs = require('fs');
const path = require('path');

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
const VOYAGE_MODEL = 'voyage-3-lite';

const KNOWLEDGE_PATH = path.join(__dirname, '..', 'content', 'knowledge.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'embeddings.json');

async function embedBatch(texts) {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input: texts,
      model: VOYAGE_MODEL,
      input_type: 'document',
    }),
  });
  if (!res.ok) {
    throw new Error(`Voyage API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.data.map((d) => d.embedding);
}

async function main() {
  if (!VOYAGE_API_KEY) {
    console.error('Missing VOYAGE_API_KEY environment variable.');
    process.exit(1);
  }

  const chunks = JSON.parse(fs.readFileSync(KNOWLEDGE_PATH, 'utf8'));
  const texts = chunks.map((c) => `${c.title}\n${c.text}`);

  console.log(`Embedding ${chunks.length} chunks with ${VOYAGE_MODEL}...`);
  const embeddings = await embedBatch(texts);

  const records = chunks.map((chunk, i) => ({
    id: chunk.id,
    title: chunk.title,
    text: chunk.text,
    embedding: embeddings[i],
  }));

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ model: VOYAGE_MODEL, records }, null, 2));
  console.log(`Wrote ${records.length} embeddings to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
