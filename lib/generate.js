// Reply generation for /api/chat. Groq is the primary generator; Gemini
// only steps in once Groq's own retries (below) are exhausted, e.g. a
// sustained outage rather than a blip.
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_CHAT_MODEL = process.env.GROQ_CHAT_MODEL || 'llama-3.3-70b-versatile';
// Fallback generation provider used only if Groq's own generation retries
// (below) are exhausted. Also required (not optional) for embeddings — see
// lib/retrieval.js — so this is always expected to be set regardless of
// whether the fallback path ever actually triggers.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || 'gemini-3.5-flash';

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
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    // gemini-3.5-flash is a thinking-capable model: without
    // thinkingBudget: 0, its invisible reasoning tokens eat most of
    // maxOutputTokens before the actual reply starts, truncating ordinary
    // replies mid-sentence (finishReason MAX_TOKENS with thoughtsTokenCount
    // ~380/400 observed in practice). Thinking has no real benefit for
    // this task, so disable it outright.
    generationConfig: { maxOutputTokens: 400, thinkingConfig: { thinkingBudget: 0 } },
  });

  // Gemini only ever runs as the fallback once Groq's own retries are
  // exhausted (see generateReply below) — a single-shot failure here with
  // no retry of its own would mean a transient Gemini blip during a Groq
  // outage takes the whole reply down with no recourse left. Mirrors
  // callGroq's retry shape above.
  let lastError;
  for (let attempt = 1; attempt <= MAX_GENERATE_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body,
    });
    if (res.ok) {
      const data = await res.json();
      const parts = data.candidates && data.candidates[0] && data.candidates[0].content
        ? data.candidates[0].content.parts
        : [];
      return parts.map((p) => p.text || '').join('').trim();
    }
    lastError = new Error(`Gemini API error ${res.status}: ${await res.text()}`);
    const retryable = res.status === 503 || res.status === 429;
    if (!retryable || attempt === MAX_GENERATE_RETRIES) break;
    await sleep(GENERATE_RETRY_DELAYS_MS[attempt - 1]);
  }
  throw lastError;
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

module.exports = { generateReply };
