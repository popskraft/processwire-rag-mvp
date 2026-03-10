type Env = {
  AI: {
    run: (model: string, input: Record<string, unknown>) => Promise<unknown>;
  };
  EMBEDDING_MODEL?: string;
  QDRANT_API_KEY: string;
  QDRANT_COLLECTION: string;
  QDRANT_URL: string;
  RETRIEVAL_BEARER_TOKEN?: string;
};

type SearchRequest = {
  query: string;
  limit?: number;
};

type SearchResult = {
  id: string;
  score: number;
  title: string;
  url: string;
  text: string;
};

const DEFAULT_LIMIT = 5;
const DEFAULT_MODEL = "@cf/baai/bge-base-en-v1.5";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: "processwire-rag-mvp",
        date: new Date().toISOString()
      });
    }

    if (request.method === "POST" && url.pathname === "/search") {
      if (!isAuthorized(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }

      const body = (await request.json()) as SearchRequest;
      if (!body.query || !body.query.trim()) {
        return json({ error: "Query is required" }, 400);
      }

      const queryVector = await embedQuery(body.query, env);
      const matches = await searchQdrant(queryVector, body.limit ?? DEFAULT_LIMIT, env);

      return json({
        query: body.query,
        limit: body.limit ?? DEFAULT_LIMIT,
        results: matches
      });
    }

    return json({ error: "Not found" }, 404);
  }
};

function isAuthorized(request: Request, env: Env): boolean {
  const expected = env.RETRIEVAL_BEARER_TOKEN?.trim();
  if (!expected) {
    return true;
  }

  const authHeader = request.headers.get("authorization") ?? "";
  return authHeader === `Bearer ${expected}`;
}

async function embedQuery(text: string, env: Env): Promise<number[]> {
  const response = await env.AI.run(env.EMBEDDING_MODEL || DEFAULT_MODEL, {
    text: [text]
  });

  const vector = extractFirstVector(response);
  if (!vector.length) {
    throw new Error("Embedding response did not contain a vector");
  }

  return vector;
}

function extractFirstVector(response: unknown): number[] {
  if (!response || typeof response !== "object") {
    return [];
  }

  const maybeResult = response as {
    data?: Array<number[] | { embedding?: number[] }>;
    result?: { data?: Array<number[] | { embedding?: number[] }> };
    shape?: number[];
  };

  const candidates = maybeResult.data ?? maybeResult.result?.data ?? [];
  const first = candidates[0];

  if (Array.isArray(first)) {
    return first.filter((value): value is number => typeof value === "number");
  }

  if (first && typeof first === "object" && Array.isArray(first.embedding)) {
    return first.embedding.filter((value): value is number => typeof value === "number");
  }

  return [];
}

async function searchQdrant(vector: number[], limit: number, env: Env): Promise<SearchResult[]> {
  const response = await fetch(
    `${env.QDRANT_URL}/collections/${env.QDRANT_COLLECTION}/points/query`,
    {
      method: "POST",
      headers: {
        "api-key": env.QDRANT_API_KEY,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        query: vector,
        limit,
        with_payload: true
      })
    }
  );

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Qdrant search failed: ${response.status} ${details}`);
  }

  const payload = (await response.json()) as {
    result?: {
      points?: Array<{
        id: string | number;
        score: number;
        payload?: {
          text?: string;
          title?: string;
          url?: string;
        };
      }>;
    };
  };

  const points = payload.result?.points ?? [];
  return points.map((point) => ({
    id: String(point.id),
    score: point.score,
    title: point.payload?.title ?? "Untitled",
    url: point.payload?.url ?? "",
    text: point.payload?.text ?? ""
  }));
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}
