// Vercel serverless function: retrieval-augmented chat for the Dot Marker Books site.
// POST { message: string, history?: Array<{ role: 'user' | 'assistant', text: string }> }
// -> { reply: string }
const fs = require('fs');
const path = require('path');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_EMBED_MODEL = 'gemini-embedding-001';
// gemini-2.0-flash was retired 2026-06-01; gemini-2.5-flash is current but is
// itself slated to sunset 2026-10-16 — check ai.google.dev/gemini-api/docs/deprecations
// if this endpoint starts 404ing again after that date.
const GEMINI_CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || 'gemini-2.5-flash';
const TOP_K = 4;
const MAX_MESSAGE_LENGTH = 500;
const MAX_HISTORY_TURNS = 6;

// Accepts either a Vercel KV store or a raw Upstash Redis integration —
// both expose the same REST URL/token shape, just under different env var names.
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 10;

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
}

// Sliding-window counter per IP, backed by a Redis sorted set: each request
// adds a timestamped entry, old entries fall out of the window, and we cap
// how many entries can exist within the window. Fails open (allows the
// request) if Redis isn't configured or errors, so a missing/broken rate
// limiter never takes the chat widget down — it's a crude backstop against
// scripted abuse, not a hard guarantee.
async function checkRateLimit(ip) {
  if (!REDIS_URL || !REDIS_TOKEN) return true;

  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const key = `ratelimit:chat:${ip}`;
  const member = `${now}-${Math.random().toString(36).slice(2)}`;

  try {
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        ['ZREMRANGEBYSCORE', key, 0, windowStart],
        ['ZADD', key, now, member],
        ['ZCARD', key],
        ['EXPIRE', key, Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)],
      ]),
    });
    if (!res.ok) {
      console.error(`Rate limit check failed: ${res.status} ${await res.text()}`);
      return true;
    }
    const results = await res.json();
    const count = results[2] && results[2].result;
    return typeof count !== 'number' || count <= RATE_LIMIT_MAX_REQUESTS;
  } catch (err) {
    console.error('Rate limit check errored:', err);
    return true;
  }
}

let cachedRecords = null;
function loadRecords() {
  if (!cachedRecords) {
    const filePath = path.join(process.cwd(), 'data', 'embeddings.json');
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    cachedRecords = parsed.records;
  }
  return cachedRecords;
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
  return scored.slice(0, TOP_K);
}

const SYSTEM_PROMPT = `You are the friendly customer-support chat assistant for Dot Marker Books (veronikadaves.com), a small business selling screen-free dot marker activity books for toddlers and preschoolers.

Answer ONLY using the "Context" provided below each user question. The context comes from the store's own site content.
- If the answer isn't in the context, say you're not sure and suggest they use the contact form on the site, or check the book listings on Amazon/Etsy. Do not make up facts, prices, or policies.
- Keep answers short, warm, and helpful (2-4 sentences).
- When relevant, mention the specific book title and a purchase link from the context.
- Do not answer questions unrelated to Dot Marker Books, its products, or this website.`;

async function callGemini(message, history, context) {
  const contextBlock = context
    .map((c) => `### ${c.title}\n${c.text}`)
    .join('\n\n');

  const contents = [
    ...history.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    {
      role: 'user',
      parts: [{ text: `Context:\n${contextBlock}\n\nQuestion: ${message}` }],
    },
  ];

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_CHAT_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      generationConfig: { maxOutputTokens: 400 },
    }),
  });
  if (!res.ok) {
    throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content
    ? data.candidates[0].content.parts
    : [];
  return parts.map((p) => p.text || '').join('').trim();
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!GEMINI_API_KEY) {
    res.status(500).json({ error: 'Server is missing API credentials.' });
    return;
  }

  const { message, history } = req.body || {};
  if (typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'Missing "message" in request body.' });
    return;
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    res.status(400).json({ error: 'Message is too long.' });
    return;
  }

  const allowed = await checkRateLimit(getClientIp(req));
  if (!allowed) {
    res.status(429).json({ error: 'Too many messages. Please wait a moment and try again.' });
    return;
  }

  const safeHistory = Array.isArray(history)
    ? history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
        .slice(-MAX_HISTORY_TURNS)
        .map((m) => ({ role: m.role, content: m.text.slice(0, MAX_MESSAGE_LENGTH) }))
    : [];

  try {
    const records = loadRecords();
    const queryEmbedding = await embedQuery(message);
    const context = retrieveContext(queryEmbedding, records);
    const reply = await callGemini(message, safeHistory, context);
    res.status(200).json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong generating a reply.' });
  }
};
