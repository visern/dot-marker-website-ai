# Dot Marker Books — Website + RAG Chat

Static site (`index.html`) deployed on Vercel, plus a retrieval-augmented chat
widget that answers visitor questions using the site's own content.

## How the chat works

- `content/knowledge.json` — source content, chunked by topic (books, FAQ, about, contact, ...).
- `scripts/ingest.js` — embeds each chunk with the Gemini API (`gemini-embedding-001`) and
  writes `data/embeddings.json`. This runs automatically on every Vercel build
  (`vercel.json` → `buildCommand`), so the vector store is always regenerated fresh from
  `content/knowledge.json` — it is **not** committed to git (see `.gitignore`).
- `api/chat.js` — Vercel serverless function: embeds the visitor's question, finds the
  most relevant chunks (cosine similarity), and asks Gemini (`gemini-2.5-flash`) to answer
  using only that context. `vercel.json` explicitly bundles `data/**` into this function via
  `functions.includeFiles`, since the file path is built at runtime and Vercel's automatic
  bundler can't always detect it.
- **Model lifecycle note**: Google retires Gemini model IDs on a rolling basis (e.g.
  `gemini-2.0-flash` and `text-embedding-004` were both already retired by the time this
  was written). If ingestion or chat starts returning 404s, check
  https://ai.google.dev/gemini-api/docs/deprecations and bump `GEMINI_CHAT_MODEL` /
  the embed model constant in `api/chat.js` and `scripts/ingest.js`.
- The chat widget (bottom-right bubble) is inlined in `index.html` and calls `/api/chat`.
- Per-IP rate limiting: `/api/chat` caps each IP to 10 messages/minute using a sliding-window
  counter in Redis (see below). This is a crude backstop against scripted abuse of the free
  Gemini quota, not a hard guarantee — if Redis isn't configured, rate limiting is skipped
  and the endpoint still works (fails open).

## One-time setup

1. Get a free Gemini API key: https://aistudio.google.com/apikey
2. In the Vercel project settings, add `GEMINI_API_KEY` as an environment variable for
   **Production, Preview, and Development** — it's needed at build time (ingestion) and
   at request time (query embedding + generation).
3. Recommended: add the **Upstash Redis** integration from the Vercel Marketplace
   (free tier is plenty) so `/api/chat` has rate limiting. Vercel wires up the
   `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` env vars automatically —
   no code changes needed. A Vercel KV store works the same way.
4. Deploy (or redeploy). The build runs `npm run ingest` automatically, producing
   `data/embeddings.json` for that deployment.
5. Test the chat bubble on the live site.

For local development, copy `.env.example` to `.env`, fill in the key, and run
`npm run ingest` to generate a local `data/embeddings.json`.

## Updating the knowledge base

Whenever site copy changes (new book, updated FAQ, etc.), just edit
`content/knowledge.json` and redeploy — ingestion re-runs automatically as part of
the Vercel build. No manual embedding step or commit needed.
