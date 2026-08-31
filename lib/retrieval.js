// Retrieval over the site's own knowledge base for /api/chat: embeds the
// visitor's question with Gemini (Groq has no embeddings API — verified
// against their model list, docs, and pricing page), and finds the most
// relevant pre-embedded chunks from data/embeddings.json by cosine
// similarity. Also loads the product facts (data/products.json), which
// never go through embeddings at all — see loadProducts below.
const fs = require('fs');
const path = require('path');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_EMBED_MODEL = 'gemini-embedding-001';
// 4, not 3: eval/retrieval-quality.js showed gemini-embedding-001 cosine
// scores across this corpus's 10 chunks cluster tightly (~0.65-0.79 spread),
// so a genuinely relevant chunk can land just outside a tighter top-K by a
// thin margin (e.g. site-about at rank 4, 0.0037 below rank 3). One extra
// chunk per request is cheap insurance against that clustering.
const TOP_K = 4;
// Below this cosine similarity, a chunk is treated as unrelated to the
// question rather than padded in just to fill TOP_K. Calibrated against
// eval/retrieval-quality.js's 12 test questions: the 10 on-topic questions'
// best-matching chunk scored 0.69-0.79, while the 2 off-topic ones scored
// 0.50 and 0.61 — 0.65 sits in that gap with margin both ways. The old 0.3
// did nothing in practice (no chunk in this corpus ever scored that low).
// Still only 2 off-topic samples, so revisit if real off-topic traffic
// starts leaking through above this floor.
const MIN_SIMILARITY_SCORE = 0.65;

let cachedRecords = null;
function loadRecords() {
  if (!cachedRecords) {
    const filePath = path.join(process.cwd(), 'data', 'embeddings.json');
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    cachedRecords = parsed.records;
  }
  return cachedRecords;
}

// Facts (ages, page counts, links, availability) never go through embeddings
// or the model's guesswork — they're read straight from the generated
// products.json and handed to the model verbatim on every request. There
// are only 3 products, so there's no need for retrieval or a query router
// here; that becomes worth building once a catalog is too big to fit in a
// prompt outright.
let cachedProducts = null;
function loadProducts() {
  if (!cachedProducts) {
    const filePath = path.join(process.cwd(), 'data', 'products.json');
    cachedProducts = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  return cachedProducts;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function embedQuery(text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:embedContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({
      model: `models/${GEMINI_EMBED_MODEL}`,
      content: { parts: [{ text }] },
      taskType: 'RETRIEVAL_QUERY',
    }),
  });
  if (!res.ok) {
    throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.embedding.values;
}

function retrieveContext(queryEmbedding, records) {
  const scored = records.map((r) => ({
    ...r,
    score: cosineSimilarity(queryEmbedding, r.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((r) => r.score >= MIN_SIMILARITY_SCORE).slice(0, TOP_K);
}

module.exports = { loadRecords, loadProducts, embedQuery, retrieveContext };
