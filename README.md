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
├── books/*.md        marketing narrative + full contents list per book —
│                     embedded (semantic search)
└── site/*.md         about/FAQ/contact/reviews/etc. — embedded
```

- **`knowledge/products.json`** — the product database. Questions like "how
  many pages" or "where's the Amazon link" are answered straight from this
  JSON, never guessed by the model. There are only 3 products, so the whole
  file is sent on every request rather than retrieved — no query router
  needed at this scale. `scripts/ingest.js` copies it verbatim to
  `data/products.json` (no embedding involved).
- **`knowledge/books/*.md`, `knowledge/site/*.md`** — one embedded chunk per
  file, used for "tell me about," "does this book have X," "which book
  would you recommend," and general site questions (FAQ, about, contact,
  etc.). Each book's `.md` includes its full contents list (every letter
  for the ABC book, every animal for the two Animals books) pulled from the
  real interior PDFs, so the chatbot can answer "does the book have a
  llama" without needing the PDFs themselves in the repo or at build time —
  10 total chunks, no page-level chunking, no OCR.
- **`scripts/ingest.js`** — copies `products.json` and embeds the 10
  markdown files, writing `data/products.json` + `data/embeddings.json`.
  Runs automatically on every Vercel build (`vercel.json` → `buildCommand`);
  neither output file is committed to git (see `.gitignore`) — they're
  regenerated fresh each deploy.
- **`api/chat.js`** — on each message: embeds the visitor's question with
  Groq (`nomic-embed-text-v1_5`), finds the most relevant chunks from
  `data/embeddings.json` (cosine similarity), and sends Groq
  (`llama-3.3-70b-versatile`) both the full Product Database and the
  retrieved Context, with the system prompt explaining which one answers
  which kind of question. `vercel.json` explicitly bundles `data/**` into
  this function via `functions.includeFiles`, since the file path is built
  at runtime and Vercel's automatic bundler can't always detect it.
  Generation retries a couple of times on transient 503/429s before
  erroring out.
- **Generation fallback**: if Groq generation is still failing after its own
  retries (a sustained outage, not a blip), and `GEMINI_API_KEY` is set,
  `api/chat.js` falls back to Gemini (`gemini-3.5-flash`) for that reply
  instead of erroring out. This only covers the generation step — retrieval
  still relies on Groq's `nomic-embed-text-v1_5` embeddings, so a Groq
  embedding-endpoint outage still surfaces as an error even with
  `GEMINI_API_KEY` set (Gemini's embedding vectors live in a different,
  incompatible vector space than what's stored in `data/embeddings.json`).
  Optional: without `GEMINI_API_KEY`, behavior is unchanged from before this
  existed.
- **Reply cache**: the first message of a conversation is cached in Redis for
  1 hour, keyed by the normalized question text (case/whitespace-insensitive
  exact match, not semantic). A repeated FAQ-style question ("how many
  pages", "what ages") skips both Groq calls entirely and returns instantly.
  Follow-up messages (anything with prior conversation history) always skip
  the cache, since their correct answer depends on what was said earlier,
  not just the latest message on its own. This matters because Groq's free
  tier caps out at 1,000 requests/day and every uncached message costs 2 of
  them (embed + generate) — same fail-open behavior as rate limiting if
  Redis isn't configured.
- The chat widget (bottom-right bubble) is inlined in `index.html` and calls `/api/chat`.
- Per-IP rate limiting: `/api/chat` caps each IP to 10 messages/minute using a sliding-window
  counter in Redis (see below). This is a crude backstop against scripted abuse of the free
  Groq quota, not a hard guarantee — if Redis isn't configured, rate limiting is skipped
  and the endpoint still works (fails open).

## One-time setup

1. Get a free Groq API key: https://console.groq.com/keys
2. In the Vercel project settings, add `GROQ_API_KEY` as an environment variable for
   **Production, Preview, and Development** — it's needed at build time (ingestion) and
   at request time (query embedding + generation).
3. Recommended: add the **Upstash Redis** integration from the Vercel Marketplace
   (free tier is plenty) so `/api/chat` has rate limiting and the reply cache. Vercel
   wires up the `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` env vars
   automatically — no code changes needed. A Vercel KV store works the same way.
4. Optional: get a free Gemini API key (https://aistudio.google.com/apikey) and add it
   as `GEMINI_API_KEY` so chat replies keep working if Groq generation has a sustained
   outage.
5. Deploy (or redeploy). The build runs `npm run ingest` automatically, producing
   `data/embeddings.json` for that deployment.
6. Test the chat bubble on the live site.

For local development, copy `.env.example` to `.env`, fill in the key, and run
`npm run ingest` to generate a local `data/embeddings.json`.

## Updating the knowledge base

- **Edited a book card in `index.html`** (title, series, description, pages,
  ages, rating, review count, Amazon/Etsy link)? Run `npm run sync-knowledge`
  locally. It parses the book cards straight out of `index.html`, diffs them
  against `knowledge/products.json`, and rewrites just the fields that
  changed (matching cards to products by the ASIN in their Amazon URL, so it
  survives title rewording). It also updates the matching
  `knowledge/books/<id>.md` heading if the title changed. Review the printed
  diff, then commit `knowledge/products.json` (and any `.md` heading change)
  yourself — this only exists to catch drift between the visible site and
  the chatbot's facts (this is exactly how a stale ASIN once ended up live on
  the site). It's a local step, not part of the Vercel build: build-time
  file writes never get committed back to git, so running it there would
  just silently disappear on the next deploy. It only covers the fields that
  actually appear in the book cards — see below for everything else.
- **Marketing copy, a FAQ answer, or a book's contents list changed**? Edit
  the relevant file under `knowledge/books/` or `knowledge/site/` by hand —
  the long-form Amazon-style copy and "Full contents list" sections have no
  source of truth in `index.html` (the card's description is one sentence,
  not the full listing), so update those from the real interior file or
  listing — don't guess.
- **New book added**? Add a product entry to `products.json` and a new
  `knowledge/books/<id>.md` file following the existing ones (`sync-knowledge`
  will only warn about the unmatched card, not create these for you).

In every case, just redeploy — ingestion re-runs automatically as part of
the Vercel build. No manual embedding step or commit needed.
