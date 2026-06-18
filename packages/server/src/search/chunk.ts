// Heading-anchored, token-budgeted chunker. Splits a note body into sections at
// markdown ATX headings (fenced code is opaque — `#` inside a code block is not a
// heading), carries the heading breadcrumb on each chunk, and sub-splits any
// section over the token budget on paragraph boundaries. Pure + deterministic so
// the same body always yields the same chunk ids/hashes (incremental indexing).
import { contentHash } from "../vault/paths";

export interface Chunk {
  index: string; // positional id: "0", "2", or "2.1" for a sub-chunk
  headings: string[]; // breadcrumb of ancestor headings (root-first), [] for preamble
  content: string;
  contentHash: string;
  tokenCount: number;
}

export interface ChunkOptions {
  maxTokens?: number;
}

// ~4 characters per token — the standard rough estimate for English prose. Used
// only for budgeting/observability, never for billing, so an estimate is fine.
export function estimateTokens(text: string): number {
  return Math.ceil(text.trim().length / 4);
}

interface Section {
  headings: string[];
  lines: string[];
}

function splitSections(body: string): Section[] {
  const lines = body.split(/\r?\n/);
  const stack: Array<{ level: number; text: string }> = [];
  let current: Section = { headings: [], lines: [] };
  const sections: Section[] = [current];
  let inFence = false;
  let fenceMarker = "";
  for (const line of lines) {
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      const marker = fence[1] ?? "```";
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (line.trimStart().startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = "";
      }
      current.lines.push(line);
      continue;
    }
    const h = inFence ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = (h[1] ?? "#").length;
      const text = (h[2] ?? "").trim();
      while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
      stack.push({ level, text });
      current = { headings: stack.map((s) => s.text), lines: [] };
      sections.push(current);
    } else {
      current.lines.push(line);
    }
  }
  return sections;
}

function hardSplit(text: string, maxTokens: number): string[] {
  const maxChars = maxTokens * 4;
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) out.push(text.slice(i, i + maxChars));
  return out;
}

function splitByBudget(text: string, maxTokens: number): string[] {
  const paras = text.split(/\n{2,}/);
  const out: string[] = [];
  let buf: string[] = [];
  let bufTokens = 0;
  const flush = (): void => {
    if (buf.length > 0) {
      out.push(buf.join("\n\n"));
      buf = [];
      bufTokens = 0;
    }
  };
  for (const para of paras) {
    const t = estimateTokens(para);
    if (t > maxTokens) {
      flush();
      for (const piece of hardSplit(para, maxTokens)) out.push(piece);
      continue;
    }
    if (bufTokens + t > maxTokens) flush();
    buf.push(para);
    bufTokens += t;
  }
  flush();
  return out.length > 0 ? out : [text];
}

function makeChunk(index: string, headings: string[], content: string): Chunk {
  return {
    index,
    headings,
    content,
    contentHash: contentHash(content),
    tokenCount: estimateTokens(content),
  };
}

export function chunkNote(body: string, opts: ChunkOptions = {}): Chunk[] {
  const maxTokens = opts.maxTokens ?? 512;
  const sections = splitSections(body);
  const chunks: Chunk[] = [];
  sections.forEach((section, sectionIdx) => {
    const text = section.lines.join("\n").trim();
    if (text === "") return;
    if (estimateTokens(text) <= maxTokens) {
      chunks.push(makeChunk(`${sectionIdx}`, section.headings, text));
    } else {
      splitByBudget(text, maxTokens).forEach((part, i) =>
        chunks.push(makeChunk(`${sectionIdx}.${i}`, section.headings, part)),
      );
    }
  });
  return chunks;
}
