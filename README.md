# Dot Marker Books — Website + RAG Chat

Static site (`index.html`) deployed on Vercel, plus a retrieval-augmented chat
widget that answers visitor questions using the site's own content.

## Architecture

Facts and narrative are deliberately kept in separate systems, the way a
real product catalog would be — not everything goes through embeddings:

```
knowledge/
├── products.json     facts (ages, pages, links, ratings) — NEVER embedded,
│                     read verbatim and handed to the model on every request
├── books/*.md        marketing narrative per book — embedded (semantic search)
├── site/*.md         about/FAQ/contact/reviews/etc. — embedded
└── pdfs/*.pdf        the actual book interiors — one chunk per PAGE, embedded
                       (lets the bot answer "which page has the shark?")
```

- **`knowledge/products.json`** — the product database. Questions like "how
  many pages" or "where's the Amazon link" are answered straight from this
  JSON, never guessed by the model. There are only 3 products, so the whole
  file is sent on every request rather than retrieved — no query router
  needed at this scale. `scripts/ingest.js` copies it verbatim to
  `data/products.json` (no embedding involved).
- **`knowledge/books/*.md`, `knowledge/site/*.md`** — one embedded chunk per
  file, used for "tell me about," "which book would you recommend," and
  general site questions (FAQ, about, contact, etc.).
- **`knowledge/pdfs/*.pdf`** — the real interior files. `abc_interior.pdf`
  and `animals_interior.pdf` have a real text layer and are read directly.
  `jungle_interior.pdf` is a pure image export (Canva) with no embedded
  text at all, so its pages are rendered to PNG and OCR'd
  (`tesseract.js` + `@napi-rs/canvas`, using the locally-installed
  `@tesseract.js-data/eng` trained data — no CDN download needed at build
  time). OCR gets the vast majority of pages right automatically; the
  handful it doesn't (cursive-font truncation, one page it missed
  entirely) are fixed via a small, manually-verified `OCR_CORRECTIONS`
  table in `scripts/ingest.js` — each entry was checked against the actual
  rendered page, not guessed.
- **`scripts/ingest.js`** — runs the whole pipeline above and writes
  `data/products.json` + `data/embeddings.json`. Runs automatically on every
  Vercel build (`vercel.json` → `buildCommand`); neither output file is
  committed to git (see `.gitignore`) — they're regenerated fresh each
  deploy. Because of the OCR step, a build now takes a few minutes rather
  than seconds.
- **`api/chat.js`** — on each message: embeds the visitor's question, finds
  the most relevant chunks from `data/embeddings.json` (cosine similarity),
  and sends Gemini (`gemini-2.5-flash`) both the full Product Database and
  the retrieved Context, with the system prompt explaining which one
  answers which kind of question. `vercel.json` explicitly bundles
  `data/**` into this function via `functions.includeFiles`, since the file
  path is built at runtime and Vercel's automatic bundler can't always
  detect it.
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

- **Facts changed** (price, page count, a new purchase link, availability)?
  Edit `knowledge/products.json`.
- **Marketing copy or a FAQ answer changed**? Edit the relevant file under
  `knowledge/books/` or `knowledge/site/`.
- **A book's interior changed**, or you're adding a new book? Replace the
  PDF under `knowledge/pdfs/`. If it has a real text layer, add it to
  `TEXT_LAYER_BOOKS` in `scripts/ingest.js`; if it's image-only like
  `jungle_interior.pdf`, add it to `OCR_BOOKS` instead, then check the
  ingestion log for any garbled/missing pages and add verified corrections
  to `OCR_CORRECTIONS` (visually check the actual page before adding one —
  don't guess).

In every case, just redeploy — ingestion re-runs automatically as part of
the Vercel build. No manual embedding step or commit needed.
