// Vercel serverless function: retrieval-augmented chat for the Dot Marker Books site.
// POST { message: string, history?: Array<{ role: 'user' | 'assistant', text: string }> }
// -> { reply: string }
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_EMBED_MODEL = 'nomic-embed-text-v1_5';
const GROQ_CHAT_MODEL = process.env.GROQ_CHAT_MODEL || 'llama-3.3-70b-versatile';
// Fallback provider used only if Groq's own generation retries (below) are
// exhausted, e.g. a sustained outage rather than a brief blip. Optional: if
// GEMINI_API_KEY isn't set, the fallback is simply skipped and Groq's own
// error is returned. This only covers generation, not embeddings/retrieval —
// Gemini's embedding vectors live in a different, incompatible vector space
// than the nomic-embed-text-v1_5 vectors already stored in
// data/embeddings.json, so a Groq embedding-endpoint outage still surfaces
// as an error even with GEMINI_API_KEY set.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || 'gemini-3.5-flash';
const TOP_K = 6;
const MAX_MESSAGE_LENGTH = 500;
const MAX_HISTORY_TURNS = 6;

// Accepts either a Vercel KV store or a raw Upstash Redis integration —
// both expose the same REST URL/token shape, just under different env var names.
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 10;
// How long a cached reply stays valid. A tradeoff, not a correctness
// guarantee: knowledge/ content changes take effect on redeploy, but Redis
// is a separate store from the deployment, so a stale cached answer could
// outlive a content update by up to this long. An hour keeps that window
// short without caching so briefly it barely helps against Groq's daily quota.
const CACHE_TTL_SECONDS = 3600;

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

// Only exact-ish repeats of the same standalone question are worth caching —
// collapse casing/whitespace differences so "How many pages?" and "how many
// pages??" hit the same entry, without attempting real semantic dedup here
// (that's what the embedding search already does downstream).
function normalizeQuestion(text) {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function cacheKeyFor(message) {
  const hash = crypto.createHash('sha256').update(normalizeQuestion(message)).digest('hex');
  return `chatcache:${hash}`;
}

// Reply cache, keyed by normalized question text. Only ever used for the
// first message of a conversation (see the handler below) — a follow-up
// question's answer depends on prior turns, so it isn't safe to serve from
// a cache keyed only on the latest message. Fails open (skips the cache) if
// Redis isn't configured or errors, same as checkRateLimit.
async function getCachedReply(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['GET', key]]),
    });
    if (!res.ok) {
      console.error(`Cache read failed: ${res.status} ${await res.text()}`);
      return null;
    }
    const results = await res.json();
    return (results[0] && results[0].result) || null;
  } catch (err) {
    console.error('Cache read errored:', err);
    return null;
  }
}

async function setCachedReply(key, reply) {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', key, reply, 'EX', CACHE_TTL_SECONDS]]),
    });
    if (!res.ok) {
      console.error(`Cache write failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error('Cache write errored:', err);
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
  const res = await fetch('https://api.groq.com/openai/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model: GROQ_EMBED_MODEL, input: text }),
  });
  if (!res.ok) {
    throw new Error(`Groq API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.data[0].embedding;
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

You're given two kinds of information with each question:
- "Product Database" — exact facts (ages, page counts, ratings, purchase links, availability) for every book. This is ground truth: for questions like "how many pages" or "where do I buy it," read the answer directly from here and never estimate or contradict it.
- "Context" — passages retrieved from marketing descriptions and each book's full contents list (e.g. which letters/animals/themes a book covers). Use this for "tell me about," "does this book have X," or recommendation-style questions.

Rules:
- If the answer isn't in either source, say you're not sure and suggest the contact form on the site, or the book listings on Amazon/Etsy. Do not make up facts, prices, ages, or page numbers.
- Keep answers short, warm, and helpful (2-4 sentences).
- When relevant, mention the specific book title and a purchase link from the Product Database.
- Do not answer questions unrelated to Dot Marker Books, its products, or this website.`;

function buildUserPrompt(message, products, context) {
  const productsBlock = JSON.stringify(products, null, 2);
  const contextBlock = context
    .map((c) => `### ${c.title}\n${c.text}`)
    .join('\n\n');
  return `Product Database:\n${productsBlock}\n\nContext:\n${contextBlock}\n\nQuestion: ${message}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// This runs inline in a live request, so retries must stay short enough to
// fit inside the function's execution timeout.
const MAX_GENERATE_RETRIES = 3;
const GENERATE_RETRY_DELAYS_MS = [500, 1500];

// Groq's API is OpenAI-compatible: plain chat-completions call.
async function callGroq(message, history, products, context) {
  const userPrompt = buildUserPrompt(message, products, context);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    { role: 'user', content: userPrompt },
  ];

  let lastError;
  for (let attempt = 1; attempt <= MAX_GENERATE_RETRIES; attempt++) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({ model: GROQ_CHAT_MODEL, messages, max_tokens: 400 }),
    });
    if (res.ok) {
      const data = await res.json();
      return (data.choices && data.choices[0] && data.choices[0].message.content || '').trim();
    }
    lastError = new Error(`Groq API error ${res.status}: ${await res.text()}`);
    const retryable = res.status === 503 || res.status === 429;
    if (!retryable || attempt === MAX_GENERATE_RETRIES) break;
    await sleep(GENERATE_RETRY_DELAYS_MS[attempt - 1]);
  }
  throw lastError;
}

// Gemini's request shape differs from Groq's OpenAI-compatible one: contents
// use role 'model' instead of 'assistant', and the system prompt is a
// separate top-level field rather than a message in the list.
async function callGemini(message, history, products, context) {
  const userPrompt = buildUserPrompt(message, products, context);
  const contents = [
    ...history.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    { role: 'user', parts: [{ text: userPrompt }] },
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

// Groq is the primary generator; Gemini only steps in once Groq's own
// retries (above) are exhausted, e.g. a sustained outage rather than a blip.
async function generateReply(message, history, products, context) {
  try {
    return await callGroq(message, history, products, context);
  } catch (err) {
    if (!GEMINI_API_KEY) throw err;
    console.error('Groq generation failed, falling back to Gemini:', err);
    return callGemini(message, history, products, context);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!GROQ_API_KEY) {
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

  // Only cache/lookup on the first message of a conversation — a follow-up's
  // correct answer depends on the prior turns, not just its own text, so
  // caching by message text alone would risk serving a wrong reply.
  const cacheKey = safeHistory.length === 0 ? cacheKeyFor(message) : null;

  try {
    if (cacheKey) {
      const cached = await getCachedReply(cacheKey);
      if (cached) {
        res.status(200).json({ reply: cached });
        return;
      }
    }

    const products = loadProducts();
    const records = loadRecords();
    const queryEmbedding = await embedQuery(message);
    const context = retrieveContext(queryEmbedding, records);
    const reply = await generateReply(message, safeHistory, products, context);

    if (cacheKey) {
      await setCachedReply(cacheKey, reply);
    }

    res.status(200).json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong generating a reply.' });
  }
};
