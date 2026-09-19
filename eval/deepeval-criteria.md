# DeepEval criteria for the Dot Marker Books chatbot

> **The runnable version of this eval lives in `eval/langsmith-eval.js`**
> (`npm run eval`), built on LangSmith instead of DeepEval. This file is kept
> as reference for the underlying rubric/rationale — the actual rules below
> are the same ones encoded as the LangSmith judge prompt.

Reference material for evaluating `/api/chat` responses with
[DeepEval](https://docs.confident-ai.com/), specifically its `GEval` metric
(an LLM-as-judge scored against a criteria prompt). **Not wired into this
repo** — DeepEval is a Python framework, and this project is intentionally
pure Node.js with zero dependencies. Nothing here requires installing
anything to keep working; it's a criteria prompt + sample test cases to
paste into a DeepEval setup wherever you run one.

## Why G-Eval instead of DeepEval's built-in RAG metrics

DeepEval ships ready-made metrics like `FaithfulnessMetric`,
`AnswerRelevancyMetric`, and `ContextualPrecisionMetric` — good defaults for
a typical RAG app. This chatbot's actual failure modes are more specific
than "did it use the retrieved context faithfully," because of the
products.json/knowledge split described in the README:

- A **correct** answer to "how many pages" comes from `retrieval_context`
  being *ignored* in favor of the Product Database block in the prompt —
  a generic faithfulness metric scored only against retrieved chunks
  wouldn't know that's right.
- The bot is supposed to **refuse** off-topic questions, not just avoid
  hallucinating — most RAG metrics don't check for that at all.

So the criteria below is a custom `GEval` prompt encoding this project's
actual system prompt rules (see `api/chat.js`'s `SYSTEM_PROMPT`), not a
generic RAG-quality check.

## The criteria prompt

```python
from deepeval.metrics import GEval
from deepeval.test_case import LLMTestCaseParams

dot_marker_books_correctness = GEval(
    name="DotMarkerBooksCorrectness",
    evaluation_params=[
        LLMTestCaseParams.INPUT,
        LLMTestCaseParams.ACTUAL_OUTPUT,
        LLMTestCaseParams.EXPECTED_OUTPUT,
        LLMTestCaseParams.RETRIEVAL_CONTEXT,
    ],
    evaluation_steps=[
        "Check whether any numeric fact in 'actual output' (page count, minimum/maximum age, rating, review count) matches the corresponding value in 'expected output' exactly. Penalize heavily for any mismatch, rounding, or invented number not present in 'expected output'.",
        "Check whether any purchase link (Amazon or Etsy URL) mentioned in 'actual output' matches a URL present in 'expected output'. Penalize for a fabricated or incorrect URL, and penalize for citing Etsy when the book has no Etsy listing.",
        "If 'expected output' indicates the correct behavior is to decline and suggest the contact form or Amazon/Etsy listings (because the question is unanswerable from the given facts/context), check whether 'actual output' does so instead of guessing an answer. Penalize heavily for confidently answering a question the ground truth says is unanswerable.",
        "If 'input' is unrelated to Dot Marker Books, its three products, or the website (e.g. general trivia, coding help, unrelated small talk), check whether 'actual output' declines to engage with the off-topic request rather than answering it. Penalize for engaging with clearly off-topic requests.",
        "Check whether 'actual output' stays within roughly 2-4 sentences and reads as warm and helpful rather than terse, robotic, or padded with irrelevant detail. Penalize mildly for tone/length, much less severely than for factual errors.",
        "Do not penalize 'actual output' for omitting details from 'retrieval_context' that are not necessary to answer 'input' — completeness against retrieved chunks is not the goal here, correctness against 'expected output' is.",
    ],
    threshold=0.7,
)
```

`evaluation_steps` (rather than a single freeform `criteria` string) is
deliberate — DeepEval's docs note step-by-step criteria produce more
consistent, reproducible scores than an open-ended prompt, and it lets each
rule above map directly to one line of `SYSTEM_PROMPT` in `api/chat.js`.

## Sample test cases

Real data pulled from `knowledge/products.json`, so these are actually
checkable, not placeholders. `retrieval_context` values are illustrative —
substitute whatever `api/chat.js` actually retrieved for that question in a
real run.

```python
from deepeval.test_case import LLMTestCase

test_cases = [
    # Straightforward fact lookup — must come from the Product Database, not guessed.
    LLMTestCase(
        input="How many pages is the ABC book?",
        actual_output="",  # fill in with a real /api/chat response
        expected_output="The ABC Favorite Things book has 114 pages.",
        retrieval_context=["Dot Markers Activity Book — ABC Favorite Things: Big easy dots, alphabet fun! Learn A to Z through dot painting."],
    ),
    # Fuzzy phrasing that must resolve to the right product by theme/series, not exact title match.
    LLMTestCase(
        input="How many pages is the ocean book?",
        actual_output="",
        expected_output="The Ocean Animals book has 98 pages.",
        retrieval_context=["Dot Markers Activity Book — Ocean Animals: Sharks, fish, octopus & more!"],
    ),
    # Fact not tracked at all (price) — correct behavior is to decline, not invent a number.
    LLMTestCase(
        input="How much does the jungle book cost?",
        actual_output="",
        expected_output="I'm not sure of the exact current price — please check the Amazon or Etsy listing for the Animals book (Jungle Animals Series) for up-to-date pricing.",
        retrieval_context=["Dot Markers Activity Book — Animals: Sloths, lions, monkeys & more! The jungle sequel kids keep asking for."],
    ),
    # Narrative "does it have X" question — answerable from Context, not Product Database.
    LLMTestCase(
        input="Does the jungle book have a llama in it?",
        actual_output="",
        expected_output="Yes — the Animals book (Jungle Animals Series) includes a Llama in its full animal list.",
        retrieval_context=["Full animal list: Sloth, Pufferfish, Narwhal, Blobfish, Meerkat, Platypus, Llama, Alpaca, Wombat..."],
    ),
    # Off-topic — correct behavior is to decline and redirect, not answer.
    LLMTestCase(
        input="What's the capital of France?",
        actual_output="",
        expected_output="I'm just here to help with questions about our dot marker activity books! For anything else, feel free to reach out through the contact form.",
        retrieval_context=[],
    ),
    # ABC book has no reviews yet (rating: null, review_count: 0) — must not fabricate a rating.
    LLMTestCase(
        input="What's the rating on the ABC book?",
        actual_output="",
        expected_output="The ABC Favorite Things book is newly launched and doesn't have any reviews yet — you'd be one of the first!",
        retrieval_context=["Dot Markers Activity Book — ABC Favorite Things: Just Launched."],
    ),
]
```

## Wiring it up (if/when a Python eval setup exists)

```python
from deepeval import assert_test

def test_dot_marker_books_chatbot():
    for tc in test_cases:
        assert_test(tc, [dot_marker_books_correctness])
```

Run real questions through `/api/chat` (locally or against a deployment) to
fill in `actual_output` before scoring — this file only defines the
rubric and fixtures, not a live integration with the running chatbot.
