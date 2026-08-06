// Per-IP rate limiting for /api/chat. Fails open (allows the request) if
// Redis isn't configured or errors, so a missing/broken rate limiter never
// takes the chat widget down — it's a crude backstop against scripted
// abuse, not a hard guarantee.
const redis = require('./redis');

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
// how many entries can exist within the window.
async function checkRateLimit(ip) {
  if (!redis.isConfigured) return true;

  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const key = `ratelimit:chat:${ip}`;
  const member = `${now}-${Math.random().toString(36).slice(2)}`;

  try {
    const results = await redis.pipeline([
      ['ZREMRANGEBYSCORE', key, 0, windowStart],
      ['ZADD', key, now, member],
      ['ZCARD', key],
      ['EXPIRE', key, Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)],
    ]);
    const count = results[2] && results[2].result;
    return typeof count !== 'number' || count <= RATE_LIMIT_MAX_REQUESTS;
  } catch (err) {
    console.error('Rate limit check errored:', err);
    return true;
  }
}

module.exports = { getClientIp, checkRateLimit };
