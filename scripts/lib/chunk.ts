export type TextChunk = {
  index: number;
  text: string;
};

const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_MIN_CHARS = 250;

export function chunkText(text: string, maxChars = DEFAULT_MAX_CHARS): TextChunk[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }

  const sentences = normalized.split(/(?<=[.!?])\s+/);
  const chunks: TextChunk[] = [];
  let buffer = "";

  for (const sentence of sentences) {
    const candidate = buffer ? `${buffer} ${sentence}` : sentence;
    if (candidate.length <= maxChars) {
      buffer = candidate;
      continue;
    }

    if (buffer.length >= DEFAULT_MIN_CHARS) {
      chunks.push({
        index: chunks.length,
        text: buffer
      });
      buffer = sentence;
      continue;
    }

    const parts = splitOversize(sentence, maxChars);
    if (buffer) {
      chunks.push({
        index: chunks.length,
        text: buffer
      });
      buffer = "";
    }

    for (const part of parts) {
      chunks.push({
        index: chunks.length,
        text: part
      });
    }
  }

  if (buffer) {
    chunks.push({
      index: chunks.length,
      text: buffer
    });
  }

  return chunks;
}

function splitOversize(text: string, maxChars: number): string[] {
  const parts: string[] = [];
  let remainder = text.trim();

  while (remainder.length > maxChars) {
    parts.push(remainder.slice(0, maxChars));
    remainder = remainder.slice(maxChars).trim();
  }

  if (remainder) {
    parts.push(remainder);
  }

  return parts;
}
