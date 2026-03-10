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
