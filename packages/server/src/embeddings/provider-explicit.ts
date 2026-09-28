// GH #995 fix round 2 (root cause). `embeddingsProviderExplicit` used to be a value every caller
// that could construct an embedding provider had to remember to thread BY HAND, from config
// loading all the way down to `applyStickyEmbeddings` — and `buildServerRuntime`'s own copy of
// that parameter defaulted to `true`, the UNSAFE value ("treat as explicit, skip sticky
// resolution"). A caller that never learned sticky resolution existed (rerun.ts calling
// `buildServerRuntime` with only its first two arguments) silently constructed the schema-default
// provider and dropped `vec_chunks` on the fingerprint mismatch — the exact failure class this
// module exists to close for good, not just for the callers a review happened to name.
//
// Explicitness now lives ON the config object itself, attached exactly once — by
// config/load.ts's `finalizeConfig`, the ONE place every config-construction path (a real config
// file, or `resolve-config.ts`'s zero-config vault-path front door, which calls `finalizeConfig`
// too) passes through — and read by every downstream consumer (`applyStickyEmbeddings`) directly
// off the SAME `config.embeddings` object reference. No function signature carries this value
// anymore, so no caller can forget to pass it: there is nothing left to pass.
//
// A WeakMap keyed by the `embeddings` sub-object (not the whole ServerConfig) survives every
// `{...cfg, vaults, acl}`-shaped spread this codebase makes of a resolved ServerConfig (e.g.
// rerun.ts's `withReadOnlyAcl`) as long as the spread does not also replace `embeddings` itself —
// none of them do; `embeddings` is mutated in place (by `applyStickyEmbeddings`), never rebuilt.
//
// A config object that never went through `finalizeConfig` (a test literal, a programmatic
// caller) has no WeakMap entry at all, and `isEmbeddingsProviderExplicitOnConfig` below reads
// that as `false` — the SAFE side: eligible for sticky "keep", never "silently switch".
const EXPLICIT = new WeakMap<object, boolean>();

/** Called exactly once, by config/load.ts's `finalizeConfig`, right after parsing — see this
 *  module's header. `embeddings` is the config's OWN `embeddings` sub-object, by reference. */
export function markEmbeddingsProviderExplicit(embeddings: object, explicit: boolean): void {
  EXPLICIT.set(embeddings, explicit);
}

/** Safe-by-default: an `embeddings` object this module never marked (a config that bypassed
 *  `finalizeConfig`) reads as NOT explicit — see this module's header for why that is the safe
 *  side. */
export function isEmbeddingsProviderExplicitOnConfig(embeddings: object): boolean {
  return EXPLICIT.get(embeddings) ?? false;
}
