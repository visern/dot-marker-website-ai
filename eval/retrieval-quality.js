#!/usr/bin/env node
// Evaluates retrieval on its own — separate from eval/langsmith-eval.js,
// which grades the full pipeline's final reply. This isolates whether
// embedQuery + retrieveContext (lib/retrieval.js) actually pull the right
// knowledge/ chunk for a question, independent of how well Groq/Gemini
// writes from whatever context they're given.
//
// Deterministic, not LLM-judged: for this small, fixed 10-chunk corpus we
// know the ground-truth relevant chunk(s) per question, so grading is exact
// set membership, not a subjective judge call — cheaper and more reliable
// than an LLM-as-judge for this particular question.
//
// Requires:
//   LANGSMITH_API_KEY - from https://smith.langchain.com/settings
//   GEMINI_API_KEY     - reused as the embedding model, same as lib/retrieval.js
const { Client } = require('langsmith');
const { evaluate } = require('langsmith/evaluation');
const retrieval = require('../lib/retrieval.js');

const DATASET_NAME = 'dot-marker-books-retrieval-quality';

// expectedChunkIds: at least one must appear in the retrieved context for a
// hit. Empty array means retrieval should return NOTHING for this question
// (tests that MIN_SIMILARITY_SCORE correctly filters out unrelated chunks
// rather than padding the top-K with the closest-but-irrelevant chunk).
// Chunk ids are `${source}-${filename}` from knowledge/{books,site}/*.md —
// see scripts/ingest.js.
const TEST_CASES = [
  { inputs: { question: 'What letters does the ABC book teach?' }, outputs: { expectedChunkIds: ['book-abc'] } },
  { inputs: { question: 'What sea creatures are in the ocean book?' }, outputs: { expectedChunkIds: ['book-animals'] } },
  { inputs: { question: 'Does the jungle animals book have a llama in it?' }, outputs: { expectedChunkIds: ['book-jungle'] } },
  { inputs: { question: 'Who created these dot marker books?' }, outputs: { expectedChunkIds: ['site-about'] } },
  { inputs: { question: 'Can I get a discount buying all three books together?' }, outputs: { expectedChunkIds: ['site-bundle'] } },
  { inputs: { question: 'How do I get in touch about a bulk classroom order?' }, outputs: { expectedChunkIds: ['site-contact', 'site-bundle'] } },
  { inputs: { question: 'What brand of dot markers should I use with these books?' }, outputs: { expectedChunkIds: ['site-faq'] } },
  { inputs: { question: 'How do I get the free printable sample pages?' }, outputs: { expectedChunkIds: ['site-leadmagnet'] } },
  { inputs: { question: 'What age range are these activity books designed for?' }, outputs: { expectedChunkIds: ['site-overview', 'site-faq'] } },
  { inputs: { question: 'What do other parents say about these books?' }, outputs: { expectedChunkIds: ['site-reviews'] } },
  // Off-topic: nothing in the corpus is relevant, so a well-calibrated
  // MIN_SIMILARITY_SCORE should return zero chunks rather than padding
  // top-K with the closest-but-unrelated one.
  { inputs: { question: "What's the weather like in Paris today?" }, outputs: { expectedChunkIds: [] } },
  { inputs: { question: 'Can you help me file my taxes?' }, outputs: { expectedChunkIds: [] } },
];

async function ensureDatasetSeeded(client) {
  try {
    const dataset = await client.createDataset(DATASET_NAME, {
      description: 'Ground-truth relevant chunk(s) per question, for grading retrieval in isolation from generation.',
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

// Runs only retrieval — no generation call, so no Groq/Gemini chat quota
// spent, just one Gemini embedding call per question.
async function target(input) {
  const records = retrieval.loadRecords();
  const queryEmbedding = await retrieval.embedQuery(input.question);
  const context = retrieval.retrieveContext(queryEmbedding, records);
  return {
    retrievedChunkIds: context.map((c) => c.id),
    retrievedScores: context.map((c) => Number(c.score.toFixed(3))),
  };
}

// Hit rate: did at least one expected chunk make it into the retrieved set?
// For expectedChunkIds: [] cases, a hit means retrieval correctly returned
// nothing. Also reports reciprocal rank (1/position of the first expected
// chunk) so a hit that's buried at the bottom of top-K is visibly worse
// than one retrieved first, without needing an LLM to say so.
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
      ? `Hit at rank ${firstHitIndex + 1} (reciprocal rank ${(1 / (firstHitIndex + 1)).toFixed(2)}). Retrieved: ${retrieved.join(', ')}`
      : `Expected one of [${expected.join(', ')}], got [${retrieved.join(', ')}]`,
  };
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

  const client = new Client();
  await ensureDatasetSeeded(client);

  const results = await evaluate(target, {
    data: DATASET_NAME,
    evaluators: [retrievalHitRate],
    experimentPrefix: 'dot-marker-retrieval-quality',
    client,
  });

  let hits = 0;
  let total = 0;
  // langsmith@0.8.3's evaluate() populates results.results (a plain array)
  // but marks its own async-iterator protocol as already-exhausted by the
  // time evaluate() returns (processData() sets processedCount ===
  // results.length in the same step it fills results.results) — so
  // `for await (const row of results)` silently yields nothing. Iterate the
  // plain array instead.
  for (const row of results.results) {
    total += 1;
    const evalResult = row.evaluationResults.results.find((r) => r.key === 'retrieval_hit');
    const question = row.example.inputs.question;
    if (evalResult && evalResult.score === 1) {
      hits += 1;
      console.log(`HIT  "${question}" — ${evalResult.comment}`);
    } else {
      console.log(`MISS "${question}" — ${evalResult ? evalResult.comment : 'no evaluator result (target errored)'}`);
    }
  }

  console.log(`\n${hits}/${total} retrieval hits.`);
  console.log('Full results in the LangSmith UI.');
  if (hits < total) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
