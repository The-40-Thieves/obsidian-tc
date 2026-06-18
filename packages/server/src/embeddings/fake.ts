import { jsTokenize } from "../search/native";
import type { EmbeddingProvider } from "./provider";
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
export function deterministicVector(text: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const tok of jsTokenize(text)) {
    const h = fnv1a(tok);
    const a = h % dim;
    v[a] = (v[a] ?? 0) + 1;
    const b = (h >>> 8) % dim;
    v[b] = (v[b] ?? 0) + (((h >>> 16) & 1) === 0 ? 0.5 : -0.5);
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  if (norm > 0) {
    const inv = 1 / Math.sqrt(norm);
    for (let i = 0; i < dim; i++) v[i] = (v[i] ?? 0) * inv;
  }
  return v;
}
export function fakeEmbeddingProvider(
  opts: { dimensions?: number; model?: string } = {},
): EmbeddingProvider {
  const dimensions = opts.dimensions ?? 16;
  const model = opts.model ?? "fake-det";
  return {
    id: `fake:${model}`,
    provider: "fake",
    model,
    dimensions,
    embed: (texts: string[]): Promise<number[][]> =>
      Promise.resolve(texts.map((t) => deterministicVector(t, dimensions))),
  };
}
