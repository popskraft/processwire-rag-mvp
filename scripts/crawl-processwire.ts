import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import * as cheerio from "cheerio";
import { chunkText } from "./lib/chunk.js";
import { loadConfig } from "./lib/config.js";

type PageRecord = {
  html: string;
  text: string;
  title: string;
  url: string;
};

type VectorPoint = {
  id: string;
  payload: {
    chunkIndex: number;
    contentHash: string;
    sourceHash: string;
    text: string;
    title: string;
    url: string;
  };
  vector: number[];
};

const VECTOR_SIZE = 768;
const DISTANCE = "Cosine";
const MAX_PAGES = 250;
const EMBEDDING_BATCH_SIZE = 32;
const REQUEST_DELAY_MS = 900;
const MAX_FETCH_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 2500;

async function main(): Promise<void> {
  const config = loadConfig();
  const pageHtmlMap = await crawlDocumentation(config.siteStartUrl, config.siteAllowedPrefix);
  const pages = Array.from(pageHtmlMap.entries());

  console.log(`Discovered ${pages.length} documentation pages`);

  const pageRecords = pages
    .map(([url, html]) => extractPage(url, html))
    .filter((page): page is PageRecord => Boolean(page?.text));

  console.log(`Prepared ${pageRecords.length} pages with extractable text`);

  const points = await buildPoints(pageRecords, config);
  console.log(`Prepared ${points.length} vector points`);

  await ensureCollection(config.qdrantUrl, config.qdrantCollection, config.qdrantApiKey);
  await upsertPoints(config.qdrantUrl, config.qdrantCollection, config.qdrantApiKey, points);

  const manifest = {
    date: new Date().toISOString(),
    pagesIndexed: pageRecords.length,
    pointsIndexed: points.length,
    sourceRoot: config.siteStartUrl,
    allowedPrefix: config.siteAllowedPrefix,
    embeddingModel: config.cloudflareAiModel
  };

  const manifestDir = path.resolve(process.cwd(), "manifests");
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(
    path.join(manifestDir, "latest-run.json"),
    JSON.stringify(manifest, null, 2),
    "utf8"
  );

  console.log("Indexing complete");
}

async function crawlDocumentation(startUrl: string, allowedPrefix: string): Promise<Map<string, string>> {
  const queue = [startUrl];
  const visited = new Set<string>();
  const pages = new Map<string, string>();

  while (queue.length > 0 && visited.size < MAX_PAGES) {
    const url = queue.shift()!;
    if (visited.has(url)) {
      continue;
    }

    visited.add(url);
    const html = await fetchHtml(url);
    if (!html) {
      continue;
    }

    pages.set(url, html);

    const $ = cheerio.load(html);
    $("a[href]").each((_, element) => {
      const href = $(element).attr("href");
      if (!href) {
        return;
      }

      const nextUrl = normalizeUrl(url, href);
      if (!nextUrl) {
        return;
      }

      if (!nextUrl.startsWith(allowedPrefix)) {
        return;
      }

      if (!visited.has(nextUrl) && !queue.includes(nextUrl)) {
        queue.push(nextUrl);
      }
    });
  }

  return pages;
}

function extractPage(url: string, html: string): PageRecord | null {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();

  const title = $("title").first().text().trim() || "Untitled";
  const candidates = [
    $("main").first(),
    $(".uk-article").first(),
    $("article").first(),
    $(".content").first(),
    $("body").first()
  ];

  const container = candidates.find((candidate) => candidate.length > 0);
  const text = container?.text().replace(/\s+/g, " ").trim() ?? "";

  if (!text) {
    return null;
  }

  return {
    html,
    text,
    title,
    url
  };
}

async function buildPoints(
  pages: PageRecord[],
  config: ReturnType<typeof loadConfig>
): Promise<VectorPoint[]> {
  const documents = pages.flatMap((page) => {
    const sourceHash = sha256(page.url + page.title + page.text);
    return chunkText(page.text).map((chunk) => ({
      chunkIndex: chunk.index,
      sourceHash,
      text: chunk.text,
      title: page.title,
      url: page.url
    }));
  });

  const vectors: number[][] = [];
  for (let index = 0; index < documents.length; index += EMBEDDING_BATCH_SIZE) {
    const slice = documents.slice(index, index + EMBEDDING_BATCH_SIZE);
    const batchVectors = await embedTexts(
      slice.map((item) => item.text),
      config.cloudflareAccountId,
      config.cloudflareAiModel,
      config.cloudflareApiToken
    );
    vectors.push(...batchVectors);
    console.log(`Embedded ${Math.min(index + slice.length, documents.length)} / ${documents.length} chunks`);
  }

  return documents.map((document, index) => ({
    id: randomUUID(),
    payload: {
      chunkIndex: document.chunkIndex,
      contentHash: sha256(document.text),
      sourceHash: document.sourceHash,
      text: document.text,
      title: document.title,
      url: document.url
    },
    vector: vectors[index]
  }));
}

async function embedTexts(
  texts: string[],
  accountId: string,
  model: string,
  apiToken: string
): Promise<number[][]> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        text: texts
      })
    }
  );

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Cloudflare embeddings failed: ${response.status} ${details}`);
  }

  const payload = (await response.json()) as {
    result?: {
      data?: Array<number[] | { embedding?: number[] }>;
    };
    data?: Array<number[] | { embedding?: number[] }>;
  };

  const items = payload.result?.data ?? payload.data ?? [];
  return items.map((item) => {
    if (Array.isArray(item)) {
      return item;
    }
    return item.embedding ?? [];
  });
}

async function ensureCollection(qdrantUrl: string, collection: string, apiKey: string): Promise<void> {
  const deleteResponse = await fetch(`${qdrantUrl}/collections/${collection}`, {
    method: "DELETE",
    headers: {
      "api-key": apiKey
    }
  });

  if (!deleteResponse.ok && deleteResponse.status !== 404) {
    const details = await deleteResponse.text();
    throw new Error(`Could not reset Qdrant collection: ${deleteResponse.status} ${details}`);
  }

  const response = await fetch(`${qdrantUrl}/collections/${collection}`, {
    method: "PUT",
    headers: {
      "api-key": apiKey,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      vectors: {
        size: VECTOR_SIZE,
        distance: DISTANCE
      }
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Could not ensure Qdrant collection: ${response.status} ${details}`);
  }
}

async function upsertPoints(
  qdrantUrl: string,
  collection: string,
  apiKey: string,
  points: VectorPoint[]
): Promise<void> {
  const response = await fetch(`${qdrantUrl}/collections/${collection}/points?wait=true`, {
    method: "PUT",
    headers: {
      "api-key": apiKey,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      points
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Qdrant upsert failed: ${response.status} ${details}`);
  }
}

async function fetchHtml(url: string): Promise<string | null> {
  for (let attempt = 0; attempt <= MAX_FETCH_RETRIES; attempt += 1) {
    if (attempt > 0) {
      await sleep(RETRY_BASE_DELAY_MS * attempt);
    }

    const response = await fetch(url, {
      headers: {
        "user-agent": "processwire-rag-mvp/0.1"
      }
    });

    if (response.ok) {
      await sleep(REQUEST_DELAY_MS);
      return response.text();
    }

    if (response.status === 429 && attempt < MAX_FETCH_RETRIES) {
      console.warn(`Rate limited on ${url}, retry ${attempt + 1}/${MAX_FETCH_RETRIES}`);
      continue;
    }

    console.warn(`Skipping ${url}: ${response.status}`);
    await sleep(REQUEST_DELAY_MS);
    return null;
  }

  return null;
}

function normalizeUrl(baseUrl: string, href: string): string | null {
  if (!href || href.startsWith("mailto:") || href.startsWith("javascript:")) {
    return null;
  }

  try {
    const url = new URL(href, baseUrl);
    url.hash = "";

    if (url.pathname.endsWith("/")) {
      return url.toString();
    }

    return url.toString();
  } catch {
    return null;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
