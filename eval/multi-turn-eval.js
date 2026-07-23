#!/usr/bin/env node
// Evaluates multi-turn correctness: every other eval in this repo only
// ever sends history: [] (eval/langsmith-eval.js) or bypasses generation
// entirely (eval/retrieval-quality.js), so api/chat.js's safeHistory
// threading — the code path that lets a follow-up like "how many pages
// does it have?" resolve "it" from the prior turn — has never actually
// been exercised by anything runnable.
//
// Each test case is a whole conversation: earlier turns are sent for real
// against the live endpoint (each response feeding into the next request's
// `history`, exactly like the browser widget does), and only the final
// turn's reply is graded — against an expected behavior that's only
// answerable if the earlier turns' context carried through correctly.
//
// Requires:
//   LANGSMITH_API_KEY  - from https://smith.langchain.com/settings
//   GROQ_API_KEY       - reused as the judge model, same as api/chat.js
//   CHAT_ENDPOINT_URL  - defaults to http://localhost:3000/api/chat;
//                        point at a deployed URL to eval a real deployment
const { Client } = require('langsmith');
const { evaluate } = require('langsmith/evaluation');

const DATASET_NAME = 'dot-marker-books-multi-turn-correctness';
const CHAT_ENDPOINT_URL = process.env.CHAT_ENDPOINT_URL || 'http://localhost:3000/api/chat';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const JUDGE_MODEL = 'llama-3.3-70b-versatile';

// `turns` is every message sent by the "user," in order. Only the LAST
// turn is graded (against `expected`) — earlier turns exist purely to
// build up conversation history the final turn depends on. `expected`
// describes what's only achievable if history threading actually works.
const TEST_CASES = [
  {
    inputs: {
      turns: ['Tell me about the ABC book', 'How many pages does it have?'],
    },
    outputs: {
      expected:
        'Answers specifically about the ABC Favorite Things book\'s page count (114 pages) — "it" must resolve to the ABC book from the first turn, not a different book or a request for clarification.',
    },
  },
  {
    inputs: {
      turns: ['Does the jungle book have a llama in it?', 'What about a monkey?'],
    },
    outputs: {
      expected:
        'Answers whether the jungle/Animals book (the one just discussed) has a monkey — must stay on the jungle book from the first turn, not switch books or ask which book is meant.',
    },
  },
  {
    inputs: {
      turns: [
        "What's the capital of France?",
        'Ok never mind — how many letters does the ABC book cover?',
      ],
    },
    outputs: {
      expected:
        "Correctly answers the ABC book question (covers A-Z, 26 letters) despite the prior turn being an off-topic refusal — the earlier decline must not derail or contaminate this on-topic follow-up.",
    },
  },
  {
    inputs: {
      turns: ['How many pages is the ABC book?', 'And the ocean one?'],
    },
    outputs: {
      expected:
        "Answers with the Ocean Animals book's page count (98 pages), not the ABC book's — must switch subject to the book named in the follow-up rather than repeating the first answer verbatim (this also exercises that the reply cache, which only applies to first-turn messages, is correctly skipped for this follow-up).",
    },
  },
];

async function ensureDatasetSeeded(client) {
  try {
    const dataset = await client.createDataset(DATASET_NAME, {
      description:
        "Multi-turn conversations testing that api/chat.js's safeHistory threading actually lets follow-up questions resolve context from earlier turns.",
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

async function sendTurn(message, history) {
  const res = await fetch(CHAT_ENDPOINT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, history }),
  });
  if (!res.ok) {
    throw new Error(`Chat endpoint error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.reply;
}

// Drives the whole conversation for real, turn by turn, exactly like the
// browser widget: each turn's request carries the accumulated history of
// prior {role, text} messages, built from the endpoint's own actual
// replies (not scripted ones) — so this tests the real prompt the model
// sees on the final turn, not an approximation of it.
async function target(input) {
  const history = [];
  let reply;
  for (const message of input.turns) {
    reply = await sendTurn(message, history);
    history.push({ role: 'user', text: message });
    history.push({ role: 'assistant', text: reply });
  }
  return { finalReply: reply, transcript: history };
}

const JUDGE_PROMPT_TEMPLATE = `You are grading a customer-support chatbot's handling of a multi-turn conversation for a small business selling dot marker activity books.

Full conversation transcript (user/assistant alternating):
{transcript}

Expected behavior for the FINAL reply: {expected}

Grade ONLY the final reply against the expected behavior, in order of importance:
1. Any numeric fact (page count, age range, rating) must match exactly. A wrong or invented number is a severe failure (score 0-0.2).
2. The final reply must correctly use context from earlier turns (resolving "it," staying on the right book, not being derailed by an earlier off-topic refusal). Losing or misapplying that context is a severe failure — this is the main thing being tested here.
3. Tone/length (roughly 2-4 warm sentences) matters, but much less than the above.

Respond with ONLY a JSON object, no other text: {"score": <0-1 number>, "comment": "<one sentence explaining the score>"}`;

function formatTranscript(transcript) {
  return transcript.map((m) => `${m.role}: ${m.text}`).join('\n');
}

function buildJudgePrompt({ transcript, expected }) {
  return JUDGE_PROMPT_TEMPLATE.replace('{transcript}', formatTranscript(transcript)).replace('{expected}', expected);
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

// Each conversation makes 2-3 real chat calls before the judge even runs,
// so this eval burns through Groq's free-tier TPM budget fast when run
// back-to-back with other evals — retry once on 429 rather than treating a
// transient rate limit as a real evaluator failure.
async function callGroqJudge(prompt, attempt = 1) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
    }),
  });
  if (res.status === 429 && attempt < 3) {
    const body = await res.text();
    const match = /retry again in (\d+(?:\.\d+)?)(ms|s)/i.exec(body);
    const delayMs = match ? Number(match[1]) * (match[2] === 's' ? 1000 : 1) : 2000;
    await sleep(delayMs + 200);
    return callGroqJudge(prompt, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`Groq judge call failed ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function multiTurnCorrectness({ outputs, referenceOutputs }) {
  if (!outputs || !outputs.transcript) {
    return { key: 'multi_turn_correctness', score: 0, comment: 'Target function did not return a transcript (see run error).' };
  }
  const prompt = buildJudgePrompt({
    transcript: outputs.transcript,
    expected: referenceOutputs.expected,
  });

  const data = await callGroqJudge(prompt);
  const { score, comment } = parseJudgeResponse(data.choices[0].message.content);

  return { key: 'multi_turn_correctness', score, comment };
}

async function main() {
  if (!process.env.LANGSMITH_API_KEY) {
    console.error('Missing LANGSMITH_API_KEY environment variable.');
    process.exit(1);
  }
  if (!GROQ_API_KEY) {
    console.error('Missing GROQ_API_KEY environment variable (used as the judge model).');
    process.exit(1);
  }

  const client = new Client();
  await ensureDatasetSeeded(client);

  const results = await evaluate(target, {
    data: DATASET_NAME,
    evaluators: [multiTurnCorrectness],
    experimentPrefix: 'dot-marker-books-multi-turn',
    client,
  });

  // langsmith@0.8.3's evaluate() marks its own async-iterator protocol as
  // already-exhausted by the time it returns (see eval/retrieval-quality.js
  // for the full explanation) — iterate the plain results.results array
  // instead of `for await (const row of results)`, which silently yields
  // nothing.
  let passed = 0;
  let total = 0;
  for (const row of results.results) {
    total += 1;
    const evalResult = row.evaluationResults.results.find((r) => r.key === 'multi_turn_correctness');
    const turns = row.example.inputs.turns;
    const label = `[${turns.join(' -> ')}]`;
    if (evalResult && evalResult.score >= 0.8) {
      passed += 1;
      console.log(`PASS ${label} — ${evalResult.comment}`);
    } else {
      console.log(`FAIL ${label} — ${evalResult ? evalResult.comment : 'evaluator crashed with no result — check the run in LangSmith for the underlying error'}`);
    }
  }

  console.log(`\n${passed}/${total} multi-turn conversations passed.`);
  console.log('Full results in the LangSmith UI.');
  if (passed < total) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
