# processwire-rag-mvp

MVP remote RAG knowledge base for [ProcessWire documentation](https://processwire.com/docs/).

## Architecture

- `GitHub`: source of truth for code, manifests, and crawler configuration
- `Qdrant Cloud`: remote vector storage
- `Cloudflare Workers AI`: embeddings
- `Cloudflare Worker`: public retrieval API
- `Local or GitHub Actions runner`: crawl and index pipeline

## Repository layout

```text
.
├── .github/workflows/reindex.yml
├── manifests/
├── scripts/
│   ├── crawl-processwire.ts
│   └── lib/
├── src/
│   └── worker.ts
├── .env.example
├── package.json
└── wrangler.jsonc
```

## MVP flow

1. Crawl `https://processwire.com/docs/` and nested docs pages.
2. Extract and normalize content.
3. Chunk pages into retrieval units.
4. Generate embeddings through Cloudflare Workers AI.
5. Upsert vectors and metadata into Qdrant Cloud.
6. Query the deployed Cloudflare Worker from local project workflows.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy `.env.example` to `.env` and fill the values.
3. Log in to Cloudflare for Worker deployment:

```bash
npx wrangler login
```

4. Create the Qdrant collection and initial index:

```bash
npm run crawl:index
```

For a gentler full rebuild that follows ProcessWire's `robots.txt` crawl delay and indexes only sitemap-backed docs URLs:

```bash
npm run crawl:sitemap-slow
```

5. Deploy the retrieval Worker:

```bash
npm run deploy:worker
```

## Environment variables

- `QDRANT_URL`: full Qdrant cluster URL
- `QDRANT_API_KEY`: Qdrant API key
- `QDRANT_COLLECTION`: collection name, default `processwire_docs`
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account ID
- `CLOUDFLARE_API_TOKEN`: token with Workers AI access for indexing
- `CLOUDFLARE_AI_MODEL`: embedding model, default `@cf/baai/bge-base-en-v1.5`
- `RETRIEVAL_BEARER_TOKEN`: optional token for the public endpoint
- `SITE_START_URL`: default `https://processwire.com/docs/`
- `SITE_ALLOWED_PREFIX`: default `https://processwire.com/docs/`

## Retrieval API

- `GET /health`
- `POST /search`

Example:

```bash
curl -X POST "$WORKER_URL/search" \
  -H "content-type: application/json" \
  -d '{"query":"How do fields work in ProcessWire?","limit":5}'
```

## Using from a local project

For local development projects, treat this service as a ProcessWire knowledge lookup tool.

Recommended local environment variables:

```bash
export PROCESSWIRE_RAG_URL="https://processwire-rag-mvp.popskraft.workers.dev/search"
export PROCESSWIRE_RAG_TOKEN="YOUR_RETRIEVAL_BEARER_TOKEN"
```

Quick lookup example:

```bash
curl -s "$PROCESSWIRE_RAG_URL" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $PROCESSWIRE_RAG_TOKEN" \
  -d '{"query":"How do ProcessWire templates and fields work?","limit":3}'
```

Suggested agent workflow:

1. When implementing or debugging anything ProcessWire-related, search the RAG service first.
2. Use the retrieved docs snippets as implementation context, not as final truth if the local codebase says otherwise.
3. Prefer RAG lookup for questions about ProcessWire APIs, fields, templates, selectors, modules, hooks, access control, and admin behavior.
4. Skip the RAG lookup for purely local business logic that does not depend on ProcessWire internals.

## Reindex modes

- `npm run crawl:index`
  Fast site crawl from `/docs/` links. Good for development, but more likely to hit rate limits.
- `npm run crawl:fill-missing`
  Slow incremental fill for docs URLs present in sitemap but missing from Qdrant.
- `npm run crawl:sitemap-slow`
  Recommended stable mode. Rebuilds the collection from ProcessWire sitemap URLs only and respects a `6s` delay between page fetches.

Suggested instruction snippet for another project's `AGENTS.md`:

```markdown
## ProcessWire Knowledge Base

- For any question about ProcessWire behavior, APIs, templates, fields, selectors, hooks, modules, or admin conventions, query the remote ProcessWire RAG before making implementation decisions.
- Endpoint: `https://processwire-rag-mvp.popskraft.workers.dev/search`
- Auth: `Authorization: Bearer $PROCESSWIRE_RAG_TOKEN`
- Example query payload: `{"query":"How do repeater fields work in ProcessWire?","limit":3}`
- Use retrieved snippets as external reference context and then apply them carefully to the local project in `/Applications/MAMP/htdocs/kor-online`.
- If the local codebase behavior differs from docs, prefer the local code and note the discrepancy.
```
