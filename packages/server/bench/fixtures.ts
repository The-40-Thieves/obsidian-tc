// Deterministic synthetic vault content for the CodSpeed benchmarks. Everything is generated from a
// fixed seed so every run (locally and in CI) measures exactly the same work.

const WORDS = [
  "obsidian",
  "vault",
  "note",
  "markdown",
  "retrieval",
  "hybrid",
  "embedding",
  "frontmatter",
  "backlink",
  "graph",
  "memory",
  "confirmation",
  "chunk",
  "index",
  "periodic",
  "review",
  "project",
  "meeting",
  "naïve",
  "café",
] as const;

const TAGS = ["project", "area/work", "status/active", "idea", "reading", "daily"] as const;

/** mulberry32: tiny seeded PRNG, enough for reproducible fixtures. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)] as T;
}

function sentence(r: () => number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) {
    const w = pick(r, WORDS);
    const roll = r();
    if (roll < 0.05) out.push(`[[${w} ${i}]]`);
    else if (roll < 0.08) out.push(`[${w}](${w}/${i}.md)`);
    else if (roll < 0.11) out.push(`#${pick(r, TAGS)}`);
    else if (roll < 0.13) out.push(`\`${w}\``);
    else out.push(w);
  }
  return `${out.join(" ")}.`;
}

/** A realistic note: YAML frontmatter, nested headings, paragraphs with links/tags, a list and a
 *  fenced code block. `sections` scales the body size roughly linearly. */
export function makeNote(sections: number, seed = 1): string {
  const r = rng(seed);
  const lines: string[] = [
    "---",
    `title: Note ${seed}`,
    "aliases: [alpha, beta]",
    `tags: [${pick(r, TAGS)}, ${pick(r, TAGS)}]`,
    "status: active",
    `priority: ${Math.floor(r() * 5)}`,
    "created: 2026-10-27",
    "related:",
    '  - "[[Project Atlas]]"',
    '  - "[[Weekly Review]]"',
    "---",
    "",
  ];
  for (let s = 0; s < sections; s++) {
    lines.push(`## Section ${s}`, "", sentence(r, 60), "", sentence(r, 45), "");
    lines.push(`### Detail ${s}`, "", `- ${sentence(r, 12)}`, `- ${sentence(r, 12)}`, "");
    if (s % 3 === 0) lines.push("```ts", "const x = [[not a link]] + #not-a-tag;", "```", "");
  }
  return lines.join("\n");
}

/** Body-only text (no frontmatter) for tokenizer-style benchmarks. */
export function makeText(words: number, seed = 1): string {
  return sentence(rng(seed), words);
}

/** `n` vault-relative note paths spread over nested folders, with some duplicate basenames so link
 *  resolution exercises its ambiguity path. */
export function makePaths(n: number, seed = 1): string[] {
  const r = rng(seed);
  const folders = ["", "projects/", "areas/work/", "journal/2026/", "resources/reading/"];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const base = i % 10 === 0 ? `${pick(r, WORDS)} hub` : `${pick(r, WORDS)} ${i}`;
    out.push(`${pick(r, folders)}${base}.md`);
  }
  return out;
}

export function makeVector(dim: number, r: () => number): number[] {
  const v = new Array<number>(dim);
  for (let i = 0; i < dim; i++) v[i] = r() * 2 - 1;
  return v;
}

export function makeFloat32(len: number, seed: number): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = r() * 2 - 1;
  return out;
}

export function makeTokenIds(len: number, vocab: number, seed: number): Int32Array {
  const r = rng(seed);
  const out = new Int32Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.floor(r() * vocab);
  return out;
}
