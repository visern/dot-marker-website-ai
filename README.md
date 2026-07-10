# Dot Marker Books — Website + RAG Chat

Static site (`index.html`) deployed on Vercel, plus a retrieval-augmented chat
widget that answers visitor questions using the site's own content.

## How the chat works

- `content/knowledge.json` — source content, chunked by topic (books, FAQ, about, contact, ...).
- `scripts/ingest.js` — embeds each chunk with Voyage AI and writes `data/embeddings.json`.
  This runs automatically on every Vercel build (`vercel.json` → `buildCommand`), so the
  vector store is always regenerated fresh from `content/knowledge.json` — it is **not**
  committed to git (see `.gitignore`).
- `api/chat.js` — Vercel serverless function: embeds the visitor's question, finds the
  most relevant chunks (cosine similarity), and asks Claude to answer using only that context.
  `vercel.json` explicitly bundles `data/**` into this function via `functions.includeFiles`,
  since the file path is built at runtime and Vercel's automatic bundler can't always detect it.
- The chat widget (bottom-right bubble) is inlined in `index.html` and calls `/api/chat`.

## One-time setup

1. Get an Anthropic API key: https://console.anthropic.com/
2. Get a Voyage AI API key (embeddings): https://dash.voyageai.com/
3. In the Vercel project settings, add `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY` as
   environment variables for **Production, Preview, and Development** — both are needed
   at build time (ingestion) and at request time (query embedding + generation).
4. Deploy (or redeploy). The build runs `npm run ingest` automatically, producing
   `data/embeddings.json` for that deployment.
5. Test the chat bubble on the live site.

For local development, copy `.env.example` to `.env`, fill in both keys, and run
`npm run ingest` to generate a local `data/embeddings.json`.

## Updating the knowledge base

Whenever site copy changes (new book, updated FAQ, etc.), just edit
`content/knowledge.json` and redeploy — ingestion re-runs automatically as part of
the Vercel build. No manual embedding step or commit needed.
