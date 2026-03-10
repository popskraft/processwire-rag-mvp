import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type AppConfig = {
  cloudflareAccountId: string;
  cloudflareAiModel: string;
  cloudflareApiToken: string;
  qdrantApiKey: string;
  qdrantCollection: string;
  qdrantUrl: string;
  siteAllowedPrefix: string;
  siteStartUrl: string;
};

export function loadConfig(): AppConfig {
  loadEnvFile();

  return {
    cloudflareAccountId: mustGet("CLOUDFLARE_ACCOUNT_ID"),
    cloudflareAiModel: get("CLOUDFLARE_AI_MODEL", "@cf/baai/bge-base-en-v1.5"),
    cloudflareApiToken: mustGet("CLOUDFLARE_API_TOKEN"),
    qdrantApiKey: mustGet("QDRANT_API_KEY"),
    qdrantCollection: get("QDRANT_COLLECTION", "processwire_docs"),
    qdrantUrl: mustGet("QDRANT_URL").replace(/\/$/, ""),
    siteAllowedPrefix: get("SITE_ALLOWED_PREFIX", "https://processwire.com/docs/"),
    siteStartUrl: get("SITE_START_URL", "https://processwire.com/docs/")
  };
}

function loadEnvFile(): void {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return;
  }

  const source = readFileSync(envPath, "utf8");
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsAt = trimmed.indexOf("=");
    if (equalsAt === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsAt).trim();
    const value = trimmed.slice(equalsAt + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function mustGet(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function get(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}
