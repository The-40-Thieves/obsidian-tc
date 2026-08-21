# Graph Search — vault_graph_search tool

Extracted from inline commentary, 2026-08-21. The code carries the invariants; this note carries
the history and evidence.

Source: `packages/server/src/tools/m7/knowledge/graph-search.ts`.

## Module header — WP2.3 / THE-630

`vault_graph_search` was extracted verbatim out of `buildKnowledgeTools` (WP2.3) rather than
building its own embedder, cache, or policy state — it takes the shared `RetrievalRuntime`
constructed once in `buildKnowledgeTools`. `retrieval.embedAll` is used on both the cached
single-query path and the fan-out (THE-448) path.

THE-630's `vaults[]` field follows the exact same convention THE-448's `queries[]` established:
an ADDITIVE optional field alongside the existing required singular (`vault` / `query`), the
primary value always leads, and a set that collapses to just the primary value (absent, empty,
or every entry equal to the primary) is an EXACT no-op (AC1) — the tool runs byte-identically to
its pre-ticket behavior. See `search/federated_search.ts` for the fan-out/fusion engine; its own
header explains why fusion is rank-based RRF keyed on `(vault, path)`.

## Security invariants

Each of the three invariants below has a dedicated test in
`test/federated-search-security.test.ts`.

**1. ACL is enforced PER VAULT.** Every federated leg resolves its own `FolderAcl` from
`deps.aclByVault` (falling back to `deps.acl`, the root ACL) — the SAME fallback governance.ts's
own `aclResolver` and acl.ts's `makeIndexReadable` already use — and never reads `ctx.acl`.
`ctx.acl` is set once, by central dispatch's THE-295 swap, for the single vault named in this
tool's declared `vaultArg` field, so it can describe at most one of N federated vaults correctly.

**2. The query cache stays a per-vault isolation boundary.** Each leg's `QueryCacheContext` is
built by `cacheContextFor(..., acl)` with that SAME per-vault ACL passed explicitly (not the
`ctx.acl` default), so `aclFingerprint` — "the only thing that keeps caller A's cached results
from reaching caller B" (query_cache.ts) — is fingerprinted per vault. No new cache-key shape or
combined-fingerprint entry is introduced: each leg goes through the existing, unmodified
`cachedGraphSearch`, so a federated call reads/writes N independent per-vault cache entries,
never one.

**3. A vaultBound (HTTP-token) caller is refused before any DB/embedding work**, on the PRESENCE
of a non-empty `vaults` field alone — regardless of content, including `vaults: [ctx.vaultId]`
naming only its own vault. Central dispatch's `enforceVaultBinding` (mcp/registry/input-binding.ts)
cannot catch this by construction: it only inspects the tool's declared singular `vaultArg` field
(`"vault"`), and never looks at `vaults` at all. Relying on it here would ship the exact
cross-tenant leak class THE-563/564 were filed to close, on a brand-new surface — so the refusal
is the FIRST line of the handler, not delegated to dispatch.

## `hypothetical_answer` field (THE-451 HyDE)

HyDE (Gao 2023) is agent-supplied and MCP-native: the client writes the hypothetical answer, no
server-side LLM generates it.

Measurement-fragile per the ticket: HyDE helps under-specified/zero-shot queries and can HURT a
strong encoder on well-specified queries — this server's nomic-768 encoder plus its golden set
is squarely in the latter category. That is why it ships as an opt-in lever for the caller to
reach for on vague queries specifically, never as the default path.

## `queries` field (THE-448 multi-query fan-out)

Gains concentrate on compound / multi-facet queries and are roughly neutral on single-fact ones,
while always costing latency and agent tokens — hence opt-in, per call.

CHANGELOG.md records the aggregate golden-set result for this feature (THE-448, #450, #453) as
"measured worse (−0.047 nDCG@10, p=0.0004)" and therefore opt-in — consistent with the per-query
gains being concentrated on the compound/multi-facet slice rather than uniform across the golden
set.
