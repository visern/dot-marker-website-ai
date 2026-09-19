#!/usr/bin/env node
// Evaluates the Groq -> Gemini generation fallback (api/chat.js's
// generateReply) under a REAL failure, not a mock. We watched this exact
// path fail in practice: Groq hit a transient rate limit, fell back to
// Gemini, and Gemini's own free-tier daily quota was already exhausted
// from unrelated testing -- the code path existing isn't the same as it
// working. This script deliberately breaks Groq (an invalid API key, so
// every Groq call gets a real 401 from Groq's own API) and asserts the
// fallback still produces a correct reply via Gemini.
//
// Self-contained, unlike eval/langsmith-eval.js and eval/multi-turn-eval.js:
// those hit whatever server you already have running at CHAT_ENDPOINT_URL,
// but this eval needs to control the exact env the server loads with (a
// poisoned GROQ_API_KEY), so it spins up its own temporary in-process HTTP
// server wrapping api/chat.js and tears it down when done.
//
// A 401 is not in callGroq's retryable set (503/429), so it throws after
// exactly one attempt -- generateReply's catch has no way to succeed
// except via the Gemini fallback. A 200 response therefore already proves
// the fallback engaged; the judge grades whether Gemini's reply is
// actually correct, not just present.
//
// Requires:
//   LANGSMITH_API_KEY  - from https://smith.langchain.com/settings
//   GROQ_API_KEY       - the REAL key, used only for judge calls here (the
//                        server-under-test gets a deliberately broken one)
//   GEMINI_API_KEY     - the REAL key; this is what the fallback needs to
//                        actually work. Caveat: Gemini's free tier caps at
//                        20 requests/day (see api/chat.js) -- if that's
//                        already exhausted from other testing today, this
//                        eval will correctly report failures reflecting
//                        that real constraint, not a bug in this script.
const http = require('http');
const { Client } = require('langsmith');
const { evaluate } = require('langsmith/evaluation');

const DATASET_NAME = 'dot-marker-books-fallback-reliability';
const TEST_PORT = 3099;
const CHAT_ENDPOINT_URL = `http://localhost:${TEST_PORT}/api/chat`;
const JUDGE_MODEL = 'llama-3.3-70b-versatile';

const TEST_CASES = [
  {
    inputs: { question: 'How many pages is the ABC book?' },
    outputs: { expected: 'The ABC Favorite Things book has 114 pages.' },
  },
  {
    inputs: { question: 'Does the jungle book have a llama in it?' },
    outputs: { expected: 'Yes — the Animals book (Jungle Animals Series) includes a Llama in its full animal list.' },
  },
  {
    inputs: { question: "What's the capital of France?" },
    outputs: {
      expected:
        "Declines the off-topic question and redirects to the contact form or Amazon/Etsy listings — must not fabricate an answer.",
    },
  },
];

async function ensureDatasetSeeded(client) {
  try {
    const dataset = await client.createDataset(DATASET_NAME, {
      description: 'Tests that api/chat.js falls back to Gemini and still answers correctly when Groq generation fails.',
    });
    await client.createExamples(
      TEST_CASES.map((tc) => ({ inputs: tc.inputs, outputs: tc.outputs, dataset_id: dataset.id }))
    );
    console.log(`Created dataset "${DATASET_NAME}" and seeded ${TEST_CASES.length} examples.`);
    return dataset;
  } catch (err) {
    console.log(`Dataset "${DATASET_NAME}" already exists, reusing it as-is (not re-seeding): ${err.message}`);
    return client.readDataset({ datasetName: DATASET_NAME });
  }
}

function startTestServer(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      req.body = body ? JSON.parse(body) : {};
      res.status = (code) => {
        res.statusCode = code;
        return res;
      };
      res.json = (obj) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(obj));
      };
      handler(req, res).catch((err) => {
        console.error(err);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'internal' }));
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(TEST_PORT, () => resolve(server));
  });
}

async function target(input) {
  const res = await fetch(CHAT_ENDPOINT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: input.question, history: [] }),
  });
  if (!res.ok) {
    throw new Error(
      `Chat endpoint error ${res.status}: ${await res.text()} — the Groq key is deliberately broken for this test, so a failure here means the Gemini fallback also failed (check GEMINI_API_KEY's free-tier quota).`
    );
  }
  const data = await res.json();
  return { actual: data.reply };
}

const JUDGE_PROMPT_TEMPLATE = `You are grading a customer-support chatbot's reply for a small business selling dot marker activity books. This reply was generated by a FALLBACK provider after the primary one failed -- grade it exactly as you would any other reply; the fallback either works correctly or it doesn't.

Question asked: {question}
Expected correct behavior: {expected}
Chatbot's actual reply: {actual}

Score the actual reply from 0 to 1 against these rules, in order of importance:
1. Any numeric fact (page count, age range, rating) must match the expected value exactly. A wrong or invented number is a severe failure (score 0-0.2).
2. If the expected behavior is to decline an off-topic question, confidently answering anyway is a severe failure.
3. The reply must be coherent, on-topic, and not an error message or empty string.

Respond with ONLY a JSON object, no other text: {"score": <0-1 number>, "comment": "<one sentence explaining the score>"}`;

function buildJudgePrompt({ question, expected, actual }) {
  return JUDGE_PROMPT_TEMPLATE.replace('{question}', question).replace('{expected}', expected).replace('{actual}', actual);
}

function parseJudgeResponse(raw) {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`Judge response wasn't JSON: ${raw}`);
  }
  const parsed = JSON.parse(match[0]);
  if (typeof parsed.score !== 'number') {
    throw new Error(`Judge response missing numeric "score": ${raw}`);
  }
  return parsed;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callGroqJudge(prompt, realGroqApiKey, attempt = 1) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${realGroqApiKey}` },
    body: JSON.stringify({ model: JUDGE_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 200 }),
  });
  if (res.status === 429 && attempt < 3) {
    const body = await res.text();
    const match = /retry again in (\d+(?:\.\d+)?)(ms|s)/i.exec(body);
    const delayMs = match ? Number(match[1]) * (match[2] === 's' ? 1000 : 1) : 2000;
    await sleep(delayMs + 200);
    return callGroqJudge(prompt, realGroqApiKey, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`Groq judge call failed ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function makeEvaluator(realGroqApiKey) {
  return async function fallbackReliability({ inputs, outputs, referenceOutputs }) {
    if (!outputs || typeof outputs.actual !== 'string') {
      return {
        key: 'fallback_reliability',
        score: 0,
        comment: 'No reply came back at all — the fallback did not produce usable output (see run error).',
      };
    }
    const prompt = buildJudgePrompt({
      question: inputs.question,
      expected: referenceOutputs.expected,
      actual: outputs.actual,
    });
    const data = await callGroqJudge(prompt, realGroqApiKey);
    const { score, comment } = parseJudgeResponse(data.choices[0].message.content);
    return { key: 'fallback_reliability', score, comment };
  };
}

async function main() {
  if (!process.env.LANGSMITH_API_KEY) {
    console.error('Missing LANGSMITH_API_KEY environment variable.');
    process.exit(1);
  }
  const realGroqApiKey = process.env.GROQ_API_KEY;
  if (!realGroqApiKey) {
    console.error('Missing GROQ_API_KEY environment variable (the real one — used for judge calls only).');
    process.exit(1);
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error('Missing GEMINI_API_KEY environment variable — this is what the fallback actually needs to work.');
    process.exit(1);
  }

  // Poison the server's copy of GROQ_API_KEY before requiring api/chat.js,
  // which reads it into a module-scope const at require time. This only
  // affects this process's in-memory env for the life of this script —
  // .env.local and the real process.env.GROQ_API_KEY used for judge calls
  // above are untouched.
  process.env.GROQ_API_KEY = 'invalid-key-deliberately-broken-for-fallback-eval';
  const handler = require('../api/chat.js');
  process.env.GROQ_API_KEY = realGroqApiKey;

  const server = await startTestServer(handler);
  console.log(`Test server up on :${TEST_PORT} with a deliberately broken GROQ_API_KEY.`);

  try {
    const client = new Client();
    await ensureDatasetSeeded(client);

    const results = await evaluate(target, {
      data: DATASET_NAME,
      evaluators: [makeEvaluator(realGroqApiKey)],
      experimentPrefix: 'dot-marker-books-fallback',
      client,
    });

    // langsmith@0.8.3's evaluate() marks its own async-iterator protocol as
    // already-exhausted by the time it returns — iterate results.results
    // (a plain array) instead of `for await (const row of results)`, which
    // silently yields nothing. See eval/retrieval-quality.js.
    let passed = 0;
    let total = 0;
    for (const row of results.results) {
      total += 1;
      const evalResult = row.evaluationResults.results.find((r) => r.key === 'fallback_reliability');
      const question = row.example.inputs.question;
      if (evalResult && evalResult.score >= 0.8) {
        passed += 1;
        console.log(`PASS "${question}" — ${evalResult.comment}`);
      } else {
        console.log(`FAIL "${question}" — ${evalResult ? evalResult.comment : 'evaluator crashed with no result — check the run in LangSmith'}`);
      }
    }

    console.log(`\n${passed}/${total} fallback replies passed.`);
    console.log('Full results in the LangSmith UI.');
    if (passed < total) process.exitCode = 1;
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
