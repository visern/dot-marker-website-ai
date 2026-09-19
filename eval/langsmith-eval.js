#!/usr/bin/env node
// Runs the Dot Marker Books chatbot's correctness eval as a LangSmith
// experiment: seeds a dataset (once) from the same test cases documented in
// eval/deepeval-criteria.md, calls the live /api/chat endpoint as the
// "target," and scores each reply with an LLM-as-judge evaluator (using
// Groq, the same provider the chatbot itself uses) against this project's
// actual correctness rules (see api/chat.js's SYSTEM_PROMPT).
//
// This is a LOCAL, MANUAL tool, like scripts/sync-knowledge.js — not part
// of the Vercel build or the deployed function. `langsmith` is a
// devDependency only; api/chat.js and the deployed function stay
// dependency-free.
//
// Requires:
//   LANGSMITH_API_KEY  - from https://smith.langchain.com/settings
//   GROQ_API_KEY       - reused as the judge model, same as api/chat.js
//   CHAT_ENDPOINT_URL  - defaults to http://localhost:3000/api/chat;
//                        point at a deployed URL to eval a real deployment
const { Client } = require('langsmith');
const { evaluate } = require('langsmith/evaluation');

const DATASET_NAME = 'dot-marker-books-chat-correctness';
const CHAT_ENDPOINT_URL = process.env.CHAT_ENDPOINT_URL || 'http://localhost:3000/api/chat';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const JUDGE_MODEL = 'llama-3.3-70b-versatile';

// Same test cases as eval/deepeval-criteria.md, translated to LangSmith's
// {inputs, outputs} example shape ('outputs' here means the dataset's
// reference/expected answer, not the chatbot's actual reply).
const TEST_CASES = [
  {
    inputs: { question: 'How many pages is the ABC book?' },
    outputs: { expected: 'The ABC Favorite Things book has 114 pages.' },
  },
  {
    inputs: { question: 'How many pages is the ocean book?' },
    outputs: { expected: 'The Ocean Animals book has 98 pages.' },
  },
  {
    inputs: { question: 'How much does the jungle book cost?' },
    outputs: {
      expected:
        "I'm not sure of the exact current price — please check the Amazon or Etsy listing for the Animals book (Jungle Animals Series) for up-to-date pricing.",
    },
  },
  {
    inputs: { question: 'Does the jungle book have a llama in it?' },
    outputs: {
      expected: 'Yes — the Animals book (Jungle Animals Series) includes a Llama in its full animal list.',
    },
  },
  {
    inputs: { question: "What's the capital of France?" },
    outputs: {
      expected:
        "I'm just here to help with questions about our dot marker activity books! For anything else, feel free to reach out through the contact form.",
    },
  },
  {
    inputs: { question: "What's the rating on the ABC book?" },
    outputs: {
      expected: "The ABC Favorite Things book is newly launched and doesn't have any reviews yet — you'd be one of the first!",
    },
  },
];

// Creates the dataset + seeds it with TEST_CASES on first run; on later runs
// createDataset throws (name already taken), so we just look up the
// existing one and leave its examples as-is. This means edits to
// TEST_CASES above won't reach an already-created dataset automatically —
// delete the dataset in the LangSmith UI (or bump DATASET_NAME) to reseed.
async function ensureDatasetSeeded(client) {
  try {
    const dataset = await client.createDataset(DATASET_NAME, {
      description:
        "Correctness test cases for the Dot Marker Books chatbot's product facts, narrative answers, off-topic refusal, and \"don't know\" handling.",
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

// Calls the real, running chat endpoint — this evaluates the actual system,
// not a mocked version of it. `input` is an example's `inputs` field.
async function target(input) {
  const res = await fetch(CHAT_ENDPOINT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: input.question, history: [] }),
  });
  if (!res.ok) {
    throw new Error(`Chat endpoint error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return { actual: data.reply };
}

// LLM-as-judge evaluator encoding this project's actual correctness rules —
// same rubric as eval/deepeval-criteria.md, scored here via Groq directly
// rather than DeepEval's Python GEval.
const JUDGE_PROMPT_TEMPLATE = `You are grading a customer-support chatbot's reply for a small business selling dot marker activity books.

Question asked: {question}
Expected correct behavior: {expected}
Chatbot's actual reply: {actual}

Score the actual reply from 0 to 1 against these rules, in order of importance:
1. Any numeric fact (page count, age range, rating, review count) must match the expected value exactly. A wrong or invented number is a severe failure (score 0-0.2).
2. Any purchase link (Amazon/Etsy) must match what's in the expected answer — a fabricated or wrong URL, or citing Etsy for a book with no Etsy listing, is a severe failure.
3. If the expected behavior is to decline and redirect (contact form / Amazon / Etsy) because the question is unanswerable, confidently answering anyway is a severe failure.
4. If the question is off-topic (unrelated to Dot Marker Books), engaging with it instead of declining is a severe failure.
5. Tone/length (roughly 2-4 warm sentences) matters, but much less than the above — a factually perfect answer that's a little long should still score highly.

Respond with ONLY a JSON object, no other text: {"score": <0-1 number>, "comment": "<one sentence explaining the score>"}`;

function buildJudgePrompt({ question, expected, actual }) {
  return JUDGE_PROMPT_TEMPLATE.replace('{question}', question)
    .replace('{expected}', expected)
    .replace('{actual}', actual);
}

// The judge model is asked for JSON only, but LLMs sometimes wrap it in
// prose or a markdown code fence anyway — pull out the first {...} block
// rather than assuming JSON.parse succeeds on the raw string.
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

async function dotMarkerBooksCorrectness({ inputs, outputs, referenceOutputs }) {
  const prompt = buildJudgePrompt({
    question: inputs.question,
    expected: referenceOutputs.expected,
    actual: outputs.actual,
  });

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
    }),
  });
  if (!res.ok) {
    throw new Error(`Groq judge call failed ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const { score, comment } = parseJudgeResponse(data.choices[0].message.content);

  return { key: 'dot_marker_books_correctness', score, comment };
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
    evaluators: [dotMarkerBooksCorrectness],
    experimentPrefix: 'dot-marker-books-chat',
    client,
  });

  console.log('\nEvaluation complete — view full results in the LangSmith UI.');
  console.log(results);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
