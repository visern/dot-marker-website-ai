# Project: Dot Marker Books — Website + RAG Chat

## Core Principles
**IMPORTANT**: Verify claims empirically before shipping — never assume an API, model, or fix behaves as documented or as it "should." Check the actual model list, replay the actual request, read the actual response fields. This codebase has repeatedly broken from unverified assumptions (a hardcoded embeddings model that didn't exist on its provider, a token budget silently eaten by an undocumented "thinking" mode, an escaping helper that looked safe but wasn't) — each one only caught by testing the real behavior, not by reading docs or reasoning from memory.

**IMPORTANT**: `api/chat.js` (the deployed serverless function) stays dependency-free — zero runtime `require()`s beyond Node built-ins. `langsmith` is a `devDependency` only, used exclusively by the local `eval/` scripts. Don't add a runtime dependency to the deployed function without discussing it first.

**IMPORTANT**: Functions and modules should have one clear responsibility — this codebase's single-responsibility discipline without the rest of SOLID, which doesn't have a real referent here (no classes, no interfaces, no inheritance). `embedQuery`, `retrieveContext`, `callGroq`, `callGemini`, `generateReply` are each single-purpose; keep new code that granular rather than folding multiple concerns into one function. Don't introduce classes/interfaces/DI to satisfy this — it's about function-level scope, not architecture.

## Development Workflow
1. For a focused fix or small addition, work directly on the current branch. For multiple independent concerns (e.g. several test suites, unrelated features), create a separate branch per concern rather than bundling them — makes each one reviewable and revertible on its own.
2. Before committing a change to `api/chat.js` or `lib/`-equivalent logic, run the relevant `eval:*` script (see Quality Gates) and actually read the output — a script that runs without crashing is not the same as a script that passed.
3. Write commit messages that explain the *why*, not just the *what*: what broke, how you confirmed the fix, and what you verified afterward. Match this repo's existing commit style (`git log` for examples) — short imperative title, then a body with the real rationale.
4. Never push without being asked. Committing locally is fine; `git push` is a separate, explicit ask.
5. Never fabricate a passing test result. If a live check is blocked (e.g. an exhausted free-tier API quota), say so plainly in the commit message rather than presenting an untested change as verified.

## Architecture Overview
- **Frontend**: a single static `index.html` — vanilla JS, no framework, no build step, no bundler. The chat widget is inlined at the bottom of the file.
- **Backend**: one Vercel serverless function, `api/chat.js` — retrieval-augmented generation over the site's own content.
  - **Generation**: Groq (`llama-3.3-70b-versatile`) is primary; Gemini (`gemini-3.5-flash`) is the fallback if Groq's own retries are exhausted.
  - **Embeddings**: Gemini (`gemini-embedding-001`) only — Groq has no embeddings API (verified against their model list, docs, and pricing page; don't reintroduce a Groq embeddings call).
  - **Rate limiting & reply cache**: Redis (Upstash or Vercel KV, either env var naming scheme). Optional — both fail open if unconfigured.
- **Knowledge base**: hand-authored source of truth lives in `knowledge/` (`products.json` for facts, `books/*.md` + `site/*.md` for narrative content, one embedded chunk per file). `scripts/ingest.js` builds `data/products.json` + `data/embeddings.json` from it — this runs automatically on every Vercel build (`vercel.json` → `buildCommand`); neither `data/*.json` file is committed.
- **Analytics**: PostHog, initialized in `index.html`. Chat events (`chat_opened`, `chat_message_sent`, `chat_reply_feedback`, `chat_link_clicked`) share one `conversation_id` per page load so they aggregate per-conversation.
- **Evals**: `eval/*.js`, local/manual dev tools only, tracked as LangSmith experiments. Not part of the Vercel build.

## Code Standards
- Plain JavaScript everywhere — no TypeScript, no JSX. Node backend/tooling uses CommonJS (`require`/`module.exports`).
- No framework on either side (no Next.js/Express/React) and no build step — `index.html` is served as-is; `api/chat.js` is a single exported handler function.
- Comments explain the *why*, especially anything non-obvious learned the hard way (a specific incident, a provider quirk, a constraint discovered through testing) — not what the code already says by being well-named. Several existing comments cite the exact failure that led to the fix; keep that pattern.
- Keep `api/chat.js` free of runtime dependencies (see Core Principles).

## Quality Gates
There's no unit test framework (no Jest/Playwright) and no configured linter (no ESLint/Prettier) — don't assume either exists. Instead:
- `node --check <file>` on every changed `.js` file before committing — cheap and catches real syntax errors.
- For any change touching retrieval, generation, or the fallback path, run the matching eval and read its actual output, not just its exit code:
  - `npm run eval` — end-to-end correctness against the live `/api/chat` endpoint (Groq-judged).
  - `npm run eval:retrieval` — deterministic retrieval-only hit-rate (no LLM judge; ground truth is known for this small fixed corpus).
  - `npm run eval:multiturn` — multi-turn history threading.
  - `npm run eval:fallback` — Groq → Gemini fallback under a real forced failure.
  - `npm run eval:paraphrase` — retrieval robustness to rephrasing.
- For frontend/DOM changes (especially anything touching `innerHTML` or attribute construction), verify the actual rendered/parsed output — via a real browser, or a throwaway `jsdom` check — rather than reasoning from what the code "should" do. This caught a real XSS gap once already (see git log).
- New required env vars must be reflected in `.env.example` and `README.md` in the same change, not left implicit.

## File Organization
No rigid path convention across the repo — most categories (`api/`, `index.html`) have exactly one file, and forcing a directory template onto a single file has no payoff. Two places DO have a real convention, because they're either functionally load-bearing or likely to keep growing:

- **`knowledge/<source>/<id>.md` chunk ids are load-bearing, not just organizational.** `scripts/ingest.js` derives each chunk's id as `${source}-${filename}` (e.g. `knowledge/books/abc.md` → `book-abc`, `knowledge/site/faq.md` → `site-faq`). The `eval/*.js` scripts hardcode these ids in `expectedChunkIds`. Renaming a file under `knowledge/books/` or `knowledge/site/` silently breaks those evals — treat the filename as part of the id, not a cosmetic label.
- **`eval/<what-it-tests>-eval.js` for new eval scripts.** Existing files are inconsistent (`retrieval-quality.js` has no `-eval` suffix; `langsmith-eval.js` is named after the tool, not what it tests) — not worth renaming retroactively, but new eval scripts should follow `<what-it-tests>-eval.js` (e.g. `multi-turn-eval.js`, `fallback-reliability-eval.js`) since this directory is the one part of the repo likely to keep growing.

Otherwise:
- `api/chat.js` — the one deployed serverless function (retrieval + generation + rate limiting + cache).
- `scripts/ingest.js` — build-time: `knowledge/` → `data/*.json`. `scripts/sync-knowledge.js` — local, manual: keeps `knowledge/products.json` in sync with `index.html`'s book cards.
- `knowledge/products.json`, `knowledge/books/*.md`, `knowledge/site/*.md` — hand-authored source of truth for the chatbot's knowledge.
- `data/*.json` — generated by `scripts/ingest.js`, gitignored, not committed.
- `index.html` — the entire frontend (markup, styles, and the chat widget's JS) in one file.
