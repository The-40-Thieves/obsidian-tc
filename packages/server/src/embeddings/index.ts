import {
  assertSourcePathsAllowed,
  compileEgressFilter,
  type EgressFilter,
} from "../plane/egress-filter";
import { resolveEmbeddings, resolveEmbeddingsAsync } from "../providers/registry";
// EmbeddingsConfigLike now lives in providers/types.ts (see the comment there) — re-exported here
// for compatibility since every existing caller imports it from this module.
import type { EmbeddingsConfigLike, EmbeddingsEntry, ResolveContext } from "../providers/types";
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
/** Shared by both createEmbeddingProvider (sync) and createEmbeddingProviderAsync (boot-only,
 *  module hatch) — the revision/prefix wrapping is identical either way, only HOW the raw
 *  provider was resolved differs. */
/**
 * THE-934 fix round 1: the PORT guard, applied last so it is the OUTERMOST wrapper regardless of
 * which of withRevision/withPrefixes ran -- every embed()/embedFull() call from every consumer of
 * a provider this module hands out passes through here. Exempt for `input: "query"` (a search
 * query, a goal string, a transcript block is never vault content); every other call
 * ("document" or the default/omitted role, which is what every indexing call site uses) must
 * declare `sourcePaths` -- see EmbedOptions and assertSourcePathsAllowed for the exact
 * undefined-vs-empty-array semantics. `filter` defaults to excluding nothing when
 * `egress.excludePaths` is unset, but the DECLARATION requirement is unconditional either way, so
 * a forgotten call site still fails loudly with no exclusions configured at all.
 */
function withEgressGuard(p: EmbeddingProvider, filter: EgressFilter): EmbeddingProvider {
  const guard = (o: EmbedOptions | undefined, method: string): void => {
    if (o?.input === "query") return;
    assertSourcePathsAllowed(filter, method, o?.sourcePaths);
  };
  const wrapped: EmbeddingProvider = {
    id: p.id,
    provider: p.provider,
    model: p.model,
    dimensions: p.dimensions,
    // THE-934 fix round 2 (found while writing N1's port test): `async`, deliberately, not a plain
    // arrow returning `p.embed(...)` -- a plain arrow lets guard()'s throw happen SYNCHRONOUSLY at
    // the CALL site, before the result is ever a promise. Every real caller `await`s this inside an
    // async function, where JS converts that in-place throw into a rejection of the ENCLOSING
    // function automatically, so the bug was invisible there -- but a caller that does not
    // immediately await (`Promise.all([provider.embed(...), ...])`, `.then()`) would see an
    // uncaught synchronous exception instead of a rejected promise. Same class of bug the gateway
    // port's guardGatewayClient (gateway/client.ts) was already written to avoid.
    embed: async (texts, o) => {
      guard(o, "embed");
      return p.embed(texts, o);
    },
  };
  const full = p.embedFull?.bind(p);
  if (full)
    wrapped.embedFull = async (texts, o) => {
      guard(o, "embedFull");
      return full(texts, o);
    };
  return wrapped;
}

function applyWrappers(
  resolved: EmbeddingProvider,
  entry: EmbeddingsEntry,
  cfg: EmbeddingsConfigLike,
  excludeFilter: EgressFilter,
): EmbeddingProvider {
  const revisioned = withRevision(resolved, cfg.revision);
  // model-tier owns its own asymmetric prefixing and must not be double-wrapped.
  const qp = cfg.queryPrefix ?? "";
  const dp = cfg.documentPrefix ?? "";
  const provider =
    entry.ownsPrefixing || (qp === "" && dp === "") ? revisioned : withPrefixes(revisioned, qp, dp);
  return withEgressGuard(provider, excludeFilter);
}

export function createEmbeddingProvider(
  cfg: EmbeddingsConfigLike,
  // THE-934 fix round 2 (Minor): `override` deliberately BYPASSES applyWrappers -- and therefore
  // withEgressGuard -- entirely. That is intentional: it exists so a TEST can inject its own fully
  // controlled fake provider (see egress-port-guard.test.ts and embeddings.test.ts's "honors an
  // explicit override" case) without the guard interposing on a double the test built specifically
  // to observe calls unfiltered. No production call site may pass `override` -- doing so would be
  // constructing an ungated egress leg by definition, exactly the bug class this port exists to
  // rule out. egress-port-inventory.test.ts source-scans for `override:` outside test/ to hold
  // that invariant.
  opts: { fetchFn?: FetchFn; override?: EmbeddingProvider; excludeFilter?: EgressFilter } = {},
): EmbeddingProvider {
  if (opts.override) return opts.override;
  const { provider: resolved, entry } = resolveEmbeddings(cfg, { fetchFn: opts.fetchFn });
  return applyWrappers(resolved, entry, cfg, opts.excludeFilter ?? compileEgressFilter([]));
}

/** Boot-wiring-only counterpart of createEmbeddingProvider: the only path that can resolve an
 *  asyncOnly entry (the module hatch). CLI/eval entry points must keep calling the sync
 *  createEmbeddingProvider above, which refuses `provider: "module"` with an actionable error
 *  rather than needing to become async themselves. */
export async function createEmbeddingProviderAsync(
  cfg: EmbeddingsConfigLike,
  opts: { override?: EmbeddingProvider; excludeFilter?: EgressFilter } & ResolveContext = {},
): Promise<EmbeddingProvider> {
  if (opts.override) return opts.override;
  const { provider: resolved, entry } = await resolveEmbeddingsAsync(cfg, {
    fetchFn: opts.fetchFn,
    configDir: opts.configDir,
    securityProfile: opts.securityProfile,
    embeddings: opts.embeddings,
  });
  return applyWrappers(resolved, entry, cfg, opts.excludeFilter ?? compileEgressFilter([]));
}
export { deterministicVector, fakeEmbeddingProvider } from "./fake";
export type { EmbeddingProvider } from "./provider";
export { resolveApiKey } from "./provider";
