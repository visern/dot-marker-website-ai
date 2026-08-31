# Architecture diagrams (C4 model)

Three levels of zoom, from "what is this, for an executive" down to "what's
inside the one piece of code doing the real work." See the
[C4 model](https://c4model.com/) for the general framework this follows.

> **Why plain `flowchart` instead of Mermaid's native `C4Context`/
> `C4Container`/`C4Component` syntax**: GitHub's bundled Mermaid renderer
> doesn't include the C4 extension (confirmed as of mid-2026 — see
> [this GitHub discussion](https://github.com/orgs/community/discussions/197898)),
> so that syntax renders as broken raw text in a GitHub-viewed `.md` file.
> These use plain flowcharts styled to the same conventions instead (navy =
> person, blue = internal container/component, grey = external system),
> which GitHub renders reliably — same approach as the diagrams in the
> main README.

## Level 1: System Context

The whole system as one box, and everyone/everything outside it that talks
to it. No internals — this is the version to show someone who needs the
5-second picture, not the code.

```mermaid
flowchart TB
    visitor(["Website Visitor<br/><i>browses the site,<br/>asks the chat widget questions</i>"])
    owner(["Site Owner<br/><i>maintains book listings,<br/>knowledge base, deploys</i>"])

    system["Dot Marker Books Website<br/><i>Static storefront + AI chat widget<br/>that answers questions using the<br/>site's own content</i>"]

    groq[["Groq<br/><i>External System</i><br/>Generates chat replies"]]
    gemini[["Google Gemini<br/><i>External System</i><br/>Embeddings + backup replies"]]
    redis[["Upstash Redis<br/><i>External System</i><br/>Rate limiting + reply cache"]]
    posthog[["PostHog<br/><i>External System</i><br/>Analytics"]]
    marketplaces[["Amazon / Etsy<br/><i>External System</i><br/>Where books are actually bought"]]

    visitor -->|"browses,<br/>asks questions"| system
    owner -->|"edits content,<br/>deploys"| system
    system -->|"question in,<br/>reply out"| groq
    system -->|"embeds text;<br/>backup replies<br/>if Groq fails"| gemini
    system -->|"checks/updates<br/>rate limit + cache"| redis
    system -->|"logs chat<br/>events"| posthog
    system -->|"links visitors<br/>through to buy"| marketplaces

    classDef person fill:#08427b,color:#fff,stroke:#052e56,stroke-width:1px
    classDef system fill:#1168bd,color:#fff,stroke:#0b4884,stroke-width:2px
    classDef external fill:#999999,color:#fff,stroke:#6b6b6b,stroke-width:1px
    class visitor,owner person
    class system system
    class groq,gemini,redis,posthog,marketplaces external
```

Notably absent, on purpose: **Vercel** (the host) isn't shown — a context
diagram is about who *uses* and *depends on* the system, not what it runs
on top of. It matters at the Container level below instead.

## Level 2: Container

The deployable pieces inside that one box, and which external system each
one actually talks to.

```mermaid
flowchart TB
    visitor(["Website Visitor"])

    subgraph boundary["Dot Marker Books Website"]
        frontend["Static Frontend<br/><i>[Container: HTML + vanilla JS]</i><br/>Book catalog + chat widget UI,<br/>served by Vercel's CDN"]
        chatapi["Chat API<br/><i>[Container: Vercel Serverless<br/>Function, Node.js]</i><br/>Retrieval, generation, rate<br/>limiting, reply cache"]
        buildstep["Build Pipeline<br/><i>[Container: Node.js script,<br/>runs once per deploy]</i><br/>Turns knowledge/ into the<br/>Knowledge Store below"]
        knowledgestore[("Knowledge Store<br/><i>[Container: flat JSON files<br/>bundled with the deploy —<br/>not a real database]</i><br/>data/products.json +<br/>data/embeddings.json")]
    end

    groq[["Groq<br/><i>External System</i>"]]
    gemini[["Google Gemini<br/><i>External System</i>"]]
    redis[["Upstash Redis<br/><i>External System</i>"]]
    posthog[["PostHog<br/><i>External System</i>"]]

    visitor -->|"HTTPS"| frontend
    frontend -->|"POST /api/chat<br/>(fetch)"| chatapi
    frontend -->|"page/chat<br/>events"| posthog
    chatapi -->|"reads at<br/>request time"| knowledgestore
    buildstep -->|"writes at<br/>deploy time"| knowledgestore
    buildstep -->|"embeds<br/>knowledge/*.md"| gemini
    chatapi -->|"generate<br/>(primary)"| groq
    chatapi -->|"embed query;<br/>generate (fallback)"| gemini
    chatapi -->|"rate limit +<br/>cache"| redis

    classDef person fill:#08427b,color:#fff,stroke:#052e56
    classDef container fill:#1168bd,color:#fff,stroke:#0b4884,stroke-width:2px
    classDef datastore fill:#438dd5,color:#fff,stroke:#2e6da4
    classDef external fill:#999999,color:#fff,stroke:#6b6b6b
    class visitor person
    class frontend,chatapi,buildstep container
    class knowledgestore datastore
    class groq,gemini,redis,posthog external
```

Two pieces of the prompt's usual container vocabulary are deliberately
**absent** here, not just forgotten:
- **Message broker** — none exists. Every call in this system is a direct
  synchronous HTTP request; nothing is queued or event-driven. There's no
  background job that would need one.
- **Search index / database** — the closest equivalent is the "Knowledge
  Store," but it's two flat JSON files bundled straight into the Chat API's
  deployment package, not a running database server or vector index. At 10
  total chunks, a real index would be solving a problem this project
  doesn't have yet (see the README's Architecture section for the same
  reasoning applied to `MIN_SIMILARITY_SCORE`/`TOP_K`).

## Level 3: Component

Inside the **Chat API** container — the one with all the actual decision
logic (the other containers are comparatively simple: the frontend is one
static file, the build pipeline is a single linear script).

```mermaid
flowchart TB
    frontend["Static Frontend<br/><i>[Container]</i>"]

    subgraph chatapi["Chat API container"]
        handler["api/chat.js<br/><i>[Component: HTTP handler]</i><br/>Validates request, orchestrates<br/>the pipeline, error handling"]
        ratelimit["lib/rateLimit.js<br/><i>[Component]</i><br/>Per-IP sliding<br/>window check"]
        cache["lib/cache.js<br/><i>[Component]</i><br/>Reply cache,<br/>keyed by question"]
        redislib["lib/redis.js<br/><i>[Component]</i><br/>Shared Redis REST<br/>pipeline wrapper"]
        retrieval["lib/retrieval.js<br/><i>[Component]</i><br/>Embeds question,<br/>cosine similarity"]
        generate["lib/generate.js<br/><i>[Component]</i><br/>Groq primary,<br/>Gemini fallback"]
    end

    knowledgestore[("Knowledge Store<br/><i>[Container]</i>")]
    groq[["Groq<br/><i>External System</i>"]]
    gemini[["Google Gemini<br/><i>External System</i>"]]
    redisext[["Upstash Redis<br/><i>External System</i>"]]

    frontend -->|"POST /api/chat"| handler
    handler --> ratelimit
    handler --> cache
    handler --> retrieval
    handler --> generate
    ratelimit --> redislib
    cache --> redislib
    redislib -->|"REST pipeline"| redisext
    retrieval -->|"reads"| knowledgestore
    retrieval -->|"embed query"| gemini
    generate -->|"generate<br/>(primary)"| groq
    generate -->|"generate (fallback,<br/>after Groq retries<br/>exhausted)"| gemini

    classDef component fill:#85bbf0,color:#000,stroke:#5d82a8
    classDef container fill:#1168bd,color:#fff,stroke:#0b4884,stroke-width:2px
    classDef datastore fill:#438dd5,color:#fff,stroke:#2e6da4
    classDef external fill:#999999,color:#fff,stroke:#6b6b6b
    class handler,ratelimit,cache,redislib,retrieval,generate component
    class frontend container
    class knowledgestore datastore
    class groq,gemini,redisext external
```

`lib/redis.js` is drawn once but called from two places (`rateLimit.js` and
`cache.js`) — it's the shared low-level REST wrapper both higher-level
components sit on top of, not a third independent path to Redis.
