import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import * as cheerio from "cheerio";
import { chunkText } from "./lib/chunk.js";
import { loadConfig } from "./lib/config.js";

type PageRecord = {
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

const REQUEST_DELAY_MS = 6000;
const MAX_FETCH_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 4000;
const EMBEDDING_BATCH_SIZE = 32;
const VECTOR_SIZE = 768;
const DISTANCE = "Cosine";

async function main(): Promise<void> {
  const config = loadConfig();
  const sitemapUrls = await getSitemapDocsUrls();

  console.log(`Sitemap docs URLs: ${sitemapUrls.length}`);

  const pages: PageRecord[] = [];
  for (const url of sitemapUrls) {
    const html = await fetchHtml(url);
    if (!html) {
      continue;
    }

    const page = extractPage(url, html);
    if (page) {
      pages.push(page);
    }
  }

  console.log(`Prepared ${pages.length} pages with extractable text`);

  const points = await buildPoints(pages, config);
  console.log(`Prepared ${points.length} vector points`);

  await recreateCollection(config.qdrantUrl, config.qdrantCollection, config.qdrantApiKey);
  await upsertPoints(config.qdrantUrl, config.qdrantCollection, config.qdrantApiKey, points);

  const manifest = {
    date: new Date().toISOString(),
    pagesIndexed: pages.length,
    pointsIndexed: points.length,
    sourceRoot: config.siteStartUrl,
    allowedPrefix: config.siteAllowedPrefix,
    embeddingModel: config.cloudflareAiModel,
    mode: "sitemap-slow",
    sitemapDocsUrls: sitemapUrls.length,
    crawlDelayMs: REQUEST_DELAY_MS
  };

  const manifestDir = path.resolve(process.cwd(), "manifests");
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(
    path.join(manifestDir, "latest-run.json"),
    JSON.stringify(manifest, null, 2),
    "utf8"
  );

  console.log("Slow sitemap indexing complete");
}

async function getSitemapDocsUrls(): Promise<string[]> {
  const xml = await fetch("https://processwire.com/sitemap.xml").then((response) => response.text());
  const matches = xml.match(/<loc>(.*?)<\/loc>/g) ?? [];

  return Array.from(
    new Set(
      matches
        .map((match) => match.replace("<loc>", "").replace("</loc>", ""))
        .filter((url) => url.startsWith("https://processwire.com/docs/"))
    )
  ).sort();
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

  return { text, title, url };
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
  return items.map((item) => (Array.isArray(item) ? item : item.embedding ?? []));
}

async function recreateCollection(qdrantUrl: string, collection: string, apiKey: string): Promise<void> {
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

  const createResponse = await fetch(`${qdrantUrl}/collections/${collection}`, {
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

  if (!createResponse.ok) {
    const details = await createResponse.text();
    throw new Error(`Could not ensure Qdrant collection: ${createResponse.status} ${details}`);
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
      console.log(`Fetched ${url}`);
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
