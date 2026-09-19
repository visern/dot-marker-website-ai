// Reply cache for /api/chat, keyed by normalized question text. Only ever
// used for the first message of a conversation (see api/chat.js) — a
// follow-up question's answer depends on prior turns, so it isn't safe to
// serve from a cache keyed only on the latest message. Fails open (skips
// the cache) if Redis isn't configured or errors, same as lib/rateLimit.js.
const crypto = require('crypto');
const redis = require('./redis');

// How long a cached reply stays valid. A tradeoff, not a correctness
// guarantee: knowledge/ content changes take effect on redeploy, but Redis
// is a separate store from the deployment, so a stale cached answer could
// outlive a content update by up to this long. An hour keeps that window
// short without caching so briefly it barely helps against Groq's daily quota.
const CACHE_TTL_SECONDS = 3600;

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

async function getCachedReply(key) {
  if (!redis.isConfigured) return null;
  try {
    const results = await redis.pipeline([['GET', key]]);
    return (results[0] && results[0].result) || null;
  } catch (err) {
    console.error('Cache read errored:', err);
    return null;
  }
}

async function setCachedReply(key, reply) {
  if (!redis.isConfigured) return;
  try {
    await redis.pipeline([['SET', key, reply, 'EX', CACHE_TTL_SECONDS]]);
  } catch (err) {
    console.error('Cache write errored:', err);
  }
}

module.exports = { cacheKeyFor, getCachedReply, setCachedReply };
