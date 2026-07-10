# Dot Marker Books — Website + RAG Chat

Static site (`index.html`) deployed on Vercel, plus a retrieval-augmented chat
widget that answers visitor questions using the site's own content.

## How the chat works

- `content/knowledge.json` — source content, chunked by topic (books, FAQ, about, contact, ...).
- `scripts/ingest.js` — embeds each chunk with Voyage AI and writes `data/embeddings.json`.
- `api/chat.js` — Vercel serverless function: embeds the visitor's question, finds the
  most relevant chunks (cosine similarity), and asks Claude to answer using only that context.
- The chat widget (bottom-right bubble) is inlined in `index.html` and calls `/api/chat`.

## One-time setup

1. Get an Anthropic API key: https://console.anthropic.com/
2. Get a Voyage AI API key (embeddings): https://dash.voyageai.com/
3. Copy `.env.example` to `.env` and fill in both keys.
4. Install deps and run ingestion to build the vector store:
   ```
   npm run ingest
   ```
   This writes `data/embeddings.json`. Commit that file — it's what the deployed
   chat function reads at request time.
5. In the Vercel project settings, add `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY`
   as environment variables (Production + Preview).
6. Deploy. Test the chat bubble on the live site.

## Updating the knowledge base

Whenever site copy changes (new book, updated FAQ, etc.):
1. Edit `content/knowledge.json`.
2. Re-run `npm run ingest`.
3. Commit the updated `data/embeddings.json` and deploy.
