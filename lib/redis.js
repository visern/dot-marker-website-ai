// Thin wrapper around Upstash/Vercel KV's REST pipeline API, shared by
// lib/rateLimit.js and lib/cache.js — both hit the exact same REST shape,
// just with different Redis commands. Accepts either a Vercel KV store or
// a raw Upstash Redis integration, which expose the same REST URL/token
// shape under different env var names.
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const isConfigured = Boolean(REDIS_URL && REDIS_TOKEN);

async function pipeline(commands) {
  const res = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!res.ok) {
    throw new Error(`Redis pipeline error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

module.exports = { isConfigured, pipeline };
