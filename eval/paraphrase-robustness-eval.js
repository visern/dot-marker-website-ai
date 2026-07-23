#!/usr/bin/env node
// Evaluates retrieval robustness to paraphrasing — eval/retrieval-quality.js
// has exactly one fixed phrasing per topic, and its "who created these
// books" fix partly worked by adding the literal word "created" to
// knowledge/site/about.md to match the literal word in the question. That
// leaves an open question this eval answers: does retrieval generalize
// semantically, or is it (partly) keyword-matching luck? Deliberately
// avoids literal keyword overlap with the source chunk where the earlier
// fix added one, to test that specifically.
//
// Same deterministic grading as eval/retrieval-quality.js (ground-truth
// relevant chunks are objectively known for this small, fixed corpus, so
// no LLM judge needed) — extended with per-topic consistency: several
// paraphrases share one `topic` and one set of expected chunks, so beyond
// each paraphrase's own hit/miss, this also reports whether ALL
// paraphrases of the same underlying question retrieve the same thing, or
// whether phrasing alone flips the result.
//
// Requires:
//   LANGSMITH_API_KEY - from https://smith.langchain.com/settings
//   GEMINI_API_KEY     - reused as the embedding model, same as api/chat.js
const { Client } = require('langsmith');
const { evaluate } = require('langsmith/evaluation');
const chat = require('../api/chat.js');

const DATASET_NAME = 'dot-marker-books-paraphrase-robustness';

// Each topic is 2-3 real paraphrases of the same underlying question, all
// sharing the same expectedChunkIds. The "book-creator" topic deliberately
// avoids the word "created" — the literal word eval/retrieval-quality.js's
// fix added to knowledge/site/about.md — to test generalization beyond
// that specific keyword match.
const TOPICS = [
  {
    topic: 'book-creator',
    expectedChunkIds: ['site-about'],
    paraphrases: [
      "Who's behind these dot marker books?",
      'Who is the author of this series?',
      'Who designed the Dot Marker Learning Library?',
    ],
  },
  {
    topic: 'abc-book-contents',
    expectedChunkIds: ['book-abc'],
    paraphrases: [
      'What letters does the ABC book teach?',
      'Does the alphabet book cover every letter from A to Z?',
      "What's inside the ABC activity book?",
    ],
  },
  {
    topic: 'jungle-book-llama',
    expectedChunkIds: ['book-jungle'],
    paraphrases: [
      'Does the jungle animals book have a llama in it?',
      'Is there a llama in the jungle-themed book?',
      'Which animals are featured in the Jungle Animals Series book?',
    ],
  },
  {
    topic: 'free-samples',
    expectedChunkIds: ['site-leadmagnet'],
    paraphrases: [
      'How do I get the free printable sample pages?',
      'Can I try the books before I buy?',
      'Is there a free preview available?',
    ],
  },
  {
    topic: 'bulk-orders',
    expectedChunkIds: ['site-contact', 'site-bundle'],
    paraphrases: [
      'How do I get in touch about a bulk classroom order?',
      'Do you offer pricing for buying multiple copies for a daycare?',
      'Who do I contact for a large order?',
    ],
  },
  {
    topic: 'off-topic',
    expectedChunkIds: [],
    paraphrases: [
      'What is a good recipe for banana bread?',
      'How do I reset my WiFi router?',
      'Tell me a joke about cats.',
    ],
  },
];

const TEST_CASES = TOPICS.flatMap((t) =>
  t.paraphrases.map((question) => ({
    inputs: { question, topic: t.topic },
    outputs: { expectedChunkIds: t.expectedChunkIds },
  }))
);

async function ensureDatasetSeeded(client) {
  try {
    const dataset = await client.createDataset(DATASET_NAME, {
      description: 'Multiple paraphrases per topic, testing whether retrieval generalizes semantically or is keyword-overfit.',
    });
    await client.createExamples(
      TEST_CASES.map((tc) => ({ inputs: tc.inputs, outputs: tc.outputs, dataset_id: dataset.id }))
    );
    console.log(`Created dataset "${DATASET_NAME}" and seeded ${TEST_CASES.length} examples across ${TOPICS.length} topics.`);
    return dataset;
  } catch (err) {
    console.log(`Dataset "${DATASET_NAME}" already exists, reusing it as-is (not re-seeding): ${err.message}`);
    return client.readDataset({ datasetName: DATASET_NAME });
  }
}

async function target(input) {
  const records = chat.loadRecords();
  const queryEmbedding = await chat.embedQuery(input.question);
  const context = chat.retrieveContext(queryEmbedding, records);
  return { retrievedChunkIds: context.map((c) => c.id) };
}

async function retrievalHitRate({ outputs, referenceOutputs }) {
  const expected = referenceOutputs.expectedChunkIds;
  const retrieved = outputs.retrievedChunkIds;

  if (expected.length === 0) {
    const correct = retrieved.length === 0;
    return {
      key: 'retrieval_hit',
      score: correct ? 1 : 0,
      comment: correct
        ? 'Correctly retrieved nothing for an off-topic question.'
        : `Expected no chunks (off-topic), but retrieved: ${retrieved.join(', ')}`,
    };
  }

  const firstHitIndex = retrieved.findIndex((id) => expected.includes(id));
  const hit = firstHitIndex !== -1;
  return {
    key: 'retrieval_hit',
    score: hit ? 1 : 0,
    comment: hit
      ? `Hit at rank ${firstHitIndex + 1}. Retrieved: ${retrieved.join(', ')}`
      : `Expected one of [${expected.join(', ')}], got [${retrieved.join(', ')}]`,
  };
}

async function main() {
  if (!process.env.LANGSMITH_API_KEY) {
    console.error('Missing LANGSMITH_API_KEY environment variable.');
    process.exit(1);
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error('Missing GEMINI_API_KEY environment variable (used for embeddings, same as api/chat.js).');
    process.exit(1);
  }

  const client = new Client();
  await ensureDatasetSeeded(client);

  const results = await evaluate(target, {
    data: DATASET_NAME,
    evaluators: [retrievalHitRate],
    experimentPrefix: 'dot-marker-paraphrase-robustness',
    client,
  });

  // langsmith@0.8.3's evaluate() marks its own async-iterator protocol as
  // already-exhausted by the time it returns — iterate results.results
  // (a plain array) instead of `for await (const row of results)`, which
  // silently yields nothing. See eval/retrieval-quality.js.
  const byTopic = new Map();
  let hits = 0;
  let total = 0;
  for (const row of results.results) {
    total += 1;
    const evalResult = row.evaluationResults.results.find((r) => r.key === 'retrieval_hit');
    const { question, topic } = row.example.inputs;
    const passed = evalResult && evalResult.score === 1;
    if (passed) hits += 1;

    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(passed);

    console.log(`${passed ? 'HIT ' : 'MISS'} [${topic}] "${question}" — ${evalResult ? evalResult.comment : 'no evaluator result (target errored)'}`);
  }

  console.log(`\n${hits}/${total} paraphrase retrieval hits.`);
  console.log('\nPer-topic consistency (all paraphrases of the same question should agree):');
  let inconsistentTopics = 0;
  for (const [topic, passes] of byTopic) {
    const allSame = passes.every((p) => p === passes[0]);
    if (!allSame) inconsistentTopics += 1;
    console.log(`  ${allSame ? 'consistent  ' : 'INCONSISTENT'} ${topic}: ${passes.filter(Boolean).length}/${passes.length} paraphrases hit`);
  }
  if (inconsistentTopics > 0) {
    console.log(`\n${inconsistentTopics} topic(s) had phrasing-dependent results — retrieval isn't robust to paraphrasing there.`);
  }

  console.log('\nFull results in the LangSmith UI.');
  if (hits < total) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
