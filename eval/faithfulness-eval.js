#!/usr/bin/env node
// Evaluates faithfulness — separate from eval/langsmith-eval.js (which grades
// whether the final reply is the CORRECT answer against a fixed reference)
// and eval/retrieval-quality.js (which grades whether retrieval found the
// RIGHT chunks). This checks a narrower thing: does the reply only state
// facts actually present in what the model was given (Product Database +
// retrieved Context), or does it fabricate something — a price, a policy, an
// animal not in a book's list — that isn't grounded in either source? A
// reply can be unhelpful and still perfectly faithful (correctly saying "I'm
// not sure"), and a reply can sound right while being unfaithful (inventing
// a plausible-sounding price that appears nowhere in products.json).
//
// Runs the real retrieval + generation pipeline in-process via lib/retrieval
// and lib/generate — like eval/retrieval-quality.js, this needs no local
// server running, just API keys.
//
// Requires:
//   LANGSMITH_API_KEY - from https://smith.langchain.com/settings
//   GEMINI_API_KEY     - embeddings, same as lib/retrieval.js
//   GROQ_API_KEY        - generation (primary) and reused as the judge model
const { Client } = require('langsmith');
const { evaluate } = require('langsmith/evaluation');
const retrieval = require('../lib/retrieval.js');
const { generateReply } = require('../lib/generate.js');

const DATASET_NAME = 'dot-marker-books-faithfulness';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const JUDGE_MODEL = 'llama-3.3-70b-versatile';

// No reference answers needed — faithfulness is graded against whatever
// context/products actually got retrieved for that question at eval time,
// not against a fixed expected reply. Mix of: plain facts (should be
// grounded in the Product Database), narrative facts (should be grounded in
// Context), and deliberately unanswerable questions (nothing in either
// source should be invented — the faithful move is to decline).
const TEST_CASES = [
  { inputs: { question: 'How many pages is the ABC book?' } },
  { inputs: { question: 'Does the jungle book have a llama in it?' } },
  { inputs: { question: 'How much does the jungle book cost?' } },
  { inputs: { question: "What's the rating on the ABC book?" } },
  { inputs: { question: "What's your return policy if my child doesn't like the book?" } },
  { inputs: { question: 'Is there a French translation of these books?' } },
  { inputs: { question: 'How many sea creatures are in the ocean book?' } },
  { inputs: { question: 'Can I buy the jungle book on Etsy?' } },
];

async function ensureDatasetSeeded(client) {
  try {
    const dataset = await client.createDataset(DATASET_NAME, {
      description:
        "Questions for grading whether the chatbot's reply only states facts grounded in the Product Database/Context it was actually given, independent of whether that reply is the ideal answer.",
    });
    await client.createExamples(
      TEST_CASES.map((tc) => ({ inputs: tc.inputs, outputs: {}, dataset_id: dataset.id }))
    );
    console.log(`Created dataset "${DATASET_NAME}" and seeded ${TEST_CASES.length} examples.`);
    return dataset;
  } catch (err) {
    console.log(`Dataset "${DATASET_NAME}" already exists, reusing it as-is (not re-seeding): ${err.message}`);
    return client.readDataset({ datasetName: DATASET_NAME });
  }
}

// Runs the real pipeline (no HTTP, no rate limiting/cache — those are
// api/chat.js concerns, irrelevant here) and returns the reply *plus* the
// exact grounding material it was generated from, so the evaluator can check
// the reply against precisely what this specific run actually retrieved —
// not a static snapshot that could drift from real retrieval over time.
async function target(input) {
  const products = retrieval.loadProducts();
  const records = retrieval.loadRecords();
  const queryEmbedding = await retrieval.embedQuery(input.question);
  const context = retrieval.retrieveContext(queryEmbedding, records);
  const reply = await generateReply(input.question, [], products, context);

  return {
    reply,
    productsJson: JSON.stringify(products, null, 2),
    contextText: context.map((c) => `### ${c.title}\n${c.text}`).join('\n\n') || '(none retrieved)',
  };
}

const JUDGE_PROMPT_TEMPLATE = `You are grading whether a customer-support chatbot's reply is FAITHFUL to the information it was actually given — not whether it's the best possible answer, only whether it avoids stating anything unsupported by the provided sources.

Question asked: {question}

Product Database (ground truth facts provided to the chatbot):
{productsJson}

Context (retrieved passages provided to the chatbot):
{contextText}

Chatbot's actual reply: {reply}

Score faithfulness from 0 to 1:
- 1.0: every factual claim in the reply (numbers, ages, ratings, links, book contents, policies) is directly supported by the Product Database or Context above. Declining to answer or saying "I'm not sure" when the Product Database/Context genuinely don't cover the question ALSO scores 1.0 — that is the faithful behavior, not a failure.
- 0.0-0.3: the reply states a specific fact (a number, a price, a policy, an animal/letter not in the list, a link) that does NOT appear anywhere in the Product Database or Context above — this is a fabrication, the most severe failure this eval checks for.
- Partial scores for a reply that's mostly grounded but embellishes with one unsupported claim.

Do not penalize tone, warmth, length, or whether the answer is "helpful" — ONLY whether every stated fact traces back to the given sources.

Respond with ONLY a JSON object, no other text: {"score": <0-1 number>, "comment": "<one sentence identifying the specific supported or unsupported claim that drove the score>"}`;

function buildJudgePrompt({ question, productsJson, contextText, reply }) {
  return JUDGE_PROMPT_TEMPLATE.replace('{question}', question)
    .replace('{productsJson}', productsJson)
    .replace('{contextText}', contextText)
    .replace('{reply}', reply);
}

// Same defensive parsing as eval/langsmith-eval.js's parseJudgeResponse —
// the judge is asked for JSON only but sometimes wraps it in prose anyway.
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

async function dotMarkerBooksFaithfulness({ inputs, outputs }) {
  const prompt = buildJudgePrompt({
    question: inputs.question,
    productsJson: outputs.productsJson,
    contextText: outputs.contextText,
    reply: outputs.reply,
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

  return { key: 'dot_marker_books_faithfulness', score, comment };
}

async function main() {
  if (!process.env.LANGSMITH_API_KEY) {
    console.error('Missing LANGSMITH_API_KEY environment variable.');
    process.exit(1);
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error('Missing GEMINI_API_KEY environment variable (used for embeddings, same as lib/retrieval.js).');
    process.exit(1);
  }
  if (!GROQ_API_KEY) {
    console.error('Missing GROQ_API_KEY environment variable (used for generation and as the judge model).');
    process.exit(1);
  }

  const client = new Client();
  await ensureDatasetSeeded(client);

  const results = await evaluate(target, {
    data: DATASET_NAME,
    evaluators: [dotMarkerBooksFaithfulness],
    experimentPrefix: 'dot-marker-books-faithfulness',
    client,
  });

  let passes = 0;
  let total = 0;
  // Same langsmith@0.8.3 quirk noted in eval/retrieval-quality.js: iterate
  // results.results (a plain array), not the async-iterator protocol.
  for (const row of results.results) {
    total += 1;
    const evalResult = row.evaluationResults.results.find((r) => r.key === 'dot_marker_books_faithfulness');
    const question = row.example.inputs.question;
    if (evalResult && evalResult.score >= 0.7) {
      passes += 1;
      console.log(`FAITHFUL   "${question}" (${evalResult.score}) — ${evalResult.comment}`);
    } else {
      console.log(`UNFAITHFUL "${question}" (${evalResult ? evalResult.score : 'n/a'}) — ${evalResult ? evalResult.comment : 'no evaluator result (target errored)'}`);
    }
  }

  console.log(`\n${passes}/${total} faithful (score >= 0.7).`);
  console.log('Full results in the LangSmith UI.');
  if (passes < total) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
