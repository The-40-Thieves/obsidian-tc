import { resolveEmbeddings } from "../providers/registry";
// EmbeddingsConfigLike now lives in providers/types.ts (see the comment there) — re-exported here
// for compatibility since every existing caller imports it from this module.
import type { EmbeddingsConfigLike } from "../providers/types";
import type { FetchFn } from "./http";
import type { EmbeddingProvider, EmbedOptions } from "./provider";

export type { EmbeddingsConfigLike } from "../providers/types";

/** THE-405: prefix seam applied at the factory so EVERY provider shares it — embeds marked
 *  input:"query" get `queryPrefix`, everything else (indexing is the default path) gets
 *  `documentPrefix`. Off (identity) when both are empty. */
function withPrefixes(p: EmbeddingProvider, qp: string, dp: string): EmbeddingProvider {
  const affix = (texts: string[], o?: EmbedOptions): string[] => {
    const pre = o?.input === "query" ? qp : dp;
    return pre === "" ? texts : texts.map((t) => pre + t);
  };
  const wrapped: EmbeddingProvider = {
    id: p.id,
    provider: p.provider,
    model: p.model,
    dimensions: p.dimensions,
    embed: (texts, o) => p.embed(affix(texts, o), o),
  };
  const full = p.embedFull?.bind(p);
  if (full) wrapped.embedFull = (texts, o) => full(affix(texts, o), o);
  return wrapped;
}
/** THE-460 fix B: a declared revision must change `provider.id`, because that's the identity
 *  chunk_embeddings.model / vec_chunks.model store AND what note-plan.ts's re-embed gate compares
 *  (`ex.active_model !== model`) — model/dimensions/provider stay untouched, so this is purely an
 *  identity relabel, not a different model. Applied at the factory (the same seam withPrefixes
 *  uses) so no individual adapter needs to know about it. Absent/empty revision -> `p` unchanged. */
function withRevision(p: EmbeddingProvider, revision: string | undefined): EmbeddingProvider {
  if (!revision) return p;
  const wrapped: EmbeddingProvider = {
    id: `${p.id}@${revision}`,
    provider: p.provider,
    model: p.model,
    dimensions: p.dimensions,
    embed: (texts, o) => p.embed(texts, o),
  };
  const full = p.embedFull?.bind(p);
  if (full) wrapped.embedFull = (texts, o) => full(texts, o);
  return wrapped;
}
export function createEmbeddingProvider(
  cfg: EmbeddingsConfigLike,
  opts: { fetchFn?: FetchFn; override?: EmbeddingProvider } = {},
): EmbeddingProvider {
  if (opts.override) return opts.override;
  const { provider: resolved, entry } = resolveEmbeddings(cfg, { fetchFn: opts.fetchFn });
  const provider = withRevision(resolved, cfg.revision);
  // model-tier owns its own asymmetric prefixing and must not be double-wrapped.
  if (entry.ownsPrefixing) return provider;
  const qp = cfg.queryPrefix ?? "";
  const dp = cfg.documentPrefix ?? "";
  return qp === "" && dp === "" ? provider : withPrefixes(provider, qp, dp);
}
export { deterministicVector, fakeEmbeddingProvider } from "./fake";
export type { EmbeddingProvider } from "./provider";
export { resolveApiKey } from "./provider";
