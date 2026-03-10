import { randomUUID, createHash } from "node:crypto";
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

async function main(): Promise<void> {
  const config = loadConfig();
  const sitemapUrls = await getSitemapDocsUrls();
  const indexedUrls = await getIndexedUrls(config.qdrantUrl, config.qdrantCollection, config.qdrantApiKey);
  const missingUrls = sitemapUrls.filter((url) => !indexedUrls.has(url));

  console.log(`Sitemap docs URLs: ${sitemapUrls.length}`);
  console.log(`Indexed unique docs URLs: ${indexedUrls.size}`);
  console.log(`Missing docs URLs to fetch: ${missingUrls.length}`);

  if (missingUrls.length === 0) {
    return;
  }

  const pages: PageRecord[] = [];
  for (const url of missingUrls) {
    const html = await fetchHtml(url);
    if (!html) {
      continue;
    }

    const page = extractPage(url, html);
    if (page) {
      pages.push(page);
    }
  }

  console.log(`Fetched missing pages with extractable text: ${pages.length}`);
  const points = await buildPoints(pages, config);
  console.log(`Prepared new vector points: ${points.length}`);

  if (points.length > 0) {
    await upsertPoints(config.qdrantUrl, config.qdrantCollection, config.qdrantApiKey, points);
  }
}

async function getSitemapDocsUrls(): Promise<string[]> {
  const xml = await fetch("https://processwire.com/sitemap.xml").then((response) => response.text());
  const matches = xml.match(/<loc>(.*?)<\/loc>/g) ?? [];
  const urls = matches
    .map((match) => match.replace("<loc>", "").replace("</loc>", ""))
    .filter((url) => url.startsWith("https://processwire.com/docs/"));

  return Array.from(new Set(urls)).sort();
}

async function getIndexedUrls(qdrantUrl: string, collection: string, apiKey: string): Promise<Set<string>> {
  const urls = new Set<string>();
  let offset: string | number | null | undefined;

  while (true) {
    const response = await fetch(`${qdrantUrl}/collections/${collection}/points/scroll`, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        limit: 256,
        with_payload: true,
        with_vector: false,
        offset
      })
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Qdrant scroll failed: ${response.status} ${details}`);
    }

    const payload = (await response.json()) as {
      result?: {
        next_page_offset?: string | number | null;
        points?: Array<{
          payload?: {
            url?: string;
          };
        }>;
      };
    };

    for (const point of payload.result?.points ?? []) {
      const url = point.payload?.url;
      if (url) {
        urls.add(url);
      }
    }

    offset = payload.result?.next_page_offset;
    if (offset === null || offset === undefined) {
      break;
    }
  }

  return urls;
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
