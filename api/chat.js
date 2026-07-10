// Vercel serverless function: retrieval-augmented chat for the Dot Marker Books site.
// POST { message: string, history?: Array<{ role: 'user' | 'assistant', text: string }> }
// -> { reply: string }
const fs = require('fs');
const path = require('path');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
const VOYAGE_MODEL = 'voyage-3-lite';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const TOP_K = 4;
const MAX_MESSAGE_LENGTH = 500;
const MAX_HISTORY_TURNS = 6;

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
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input: [text],
      model: VOYAGE_MODEL,
      input_type: 'query',
    }),
  });
  if (!res.ok) {
    throw new Error(`Voyage API error ${res.status}: ${await res.text()}`);
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

Answer ONLY using the "Context" provided below each user question. The context comes from the store's own site content.
- If the answer isn't in the context, say you're not sure and suggest they use the contact form on the site, or check the book listings on Amazon/Etsy. Do not make up facts, prices, or policies.
- Keep answers short, warm, and helpful (2-4 sentences).
- When relevant, mention the specific book title and a purchase link from the context.
- Do not answer questions unrelated to Dot Marker Books, its products, or this website.`;

async function callClaude(message, history, context) {
  const contextBlock = context
    .map((c) => `### ${c.title}\n${c.text}`)
    .join('\n\n');

  const messages = [
    ...history,
    {
      role: 'user',
      content: `Context:\n${contextBlock}\n\nQuestion: ${message}`,
    },
  ];

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages,
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.content.map((block) => block.text || '').join('').trim();
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!ANTHROPIC_API_KEY || !VOYAGE_API_KEY) {
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
    const reply = await callClaude(message, safeHistory, context);
    res.status(200).json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong generating a reply.' });
  }
};
