// Vercel serverless function: retrieval-augmented chat for the Dot Marker Books site.
// POST { message: string, history?: Array<{ role: 'user' | 'assistant', text: string }> }
// -> { reply: string }
//
// This file is deliberately just HTTP-level concerns (method/credential/
// input validation, orchestration, error responses) — rate limiting,
// caching, retrieval, and generation each live in their own lib/ module.
const rateLimit = require('../lib/rateLimit');
const cache = require('../lib/cache');
const retrieval = require('../lib/retrieval');
const { generateReply } = require('../lib/generate');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
// Groq has no embeddings API (verified against their model list, docs, and
// pricing page — text generation/speech only), so embeddings always go
// through Gemini regardless of which provider generates the reply. This
// makes GEMINI_API_KEY required, not optional.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MAX_MESSAGE_LENGTH = 500;
const MAX_HISTORY_TURNS = 6;

const handler = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!GROQ_API_KEY || !GEMINI_API_KEY) {
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

  const allowed = await rateLimit.checkRateLimit(rateLimit.getClientIp(req));
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
  const cacheKey = safeHistory.length === 0 ? cache.cacheKeyFor(message) : null;

  try {
    if (cacheKey) {
      const cached = await cache.getCachedReply(cacheKey);
      if (cached) {
        res.status(200).json({ reply: cached });
        return;
      }
    }

    const products = retrieval.loadProducts();
    const records = retrieval.loadRecords();
    const queryEmbedding = await retrieval.embedQuery(message);
    const context = retrieval.retrieveContext(queryEmbedding, records);
    const reply = await generateReply(message, safeHistory, products, context);

    if (cacheKey) {
      await cache.setCachedReply(cacheKey, reply);
    }

    res.status(200).json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong generating a reply.' });
  }
};

module.exports = handler;
