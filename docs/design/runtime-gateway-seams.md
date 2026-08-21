# Runtime: gateway and reranker seams

Extracted from inline commentary, 2026-08-21. The code carries the invariants; this note carries the history and evidence.

## Boot composition order (WP5.2, issue 16)

`tool-wiring.ts` is `run_serve`'s M1-M8 tool-dependency composition and registration, extracted
verbatim out of `cli.ts`, plus the two tools its trap list calls out by name: `health` and
`index_status` register inline from live runtime state (not from a module registrar). That is why
`boot.tools_registered` (`eval/perf/collectors/boot.ts`) is pinned 2 lower than
`REGISTERED_TOOL_COUNT` — that collector's probe imports the `tools/m1..m8` registrars directly and
never touches this file or `cli.ts`, so moving these call sites changes nothing it measures.

`wireM1Tools` runs before `bridge-wiring.ts` (M1 has no bridge dependency); `wireDomainTools`
(M2-M8) runs after it, because M2's `dataviewBridge`, M3's `templaterBridge`, and M4 itself all read
the composed `M4Deps` object `bridge-wiring.ts` returns.

## `resolveDeclaredReranker`'s `local`-provider exception (THE-705 round 2, #806)

`resolveDeclaredReranker` turns a resolver returning `null` for a *declared* `reranker` block into a
boot-time failure naming the provider and what it needed — except for `provider: "local"`, which is
deliberately allowed to degrade to `null` like an absent block.

The distinction, confirmed in a round-2 adversarial review (finding 1): `model-tier`/`gateway`
resolving to `null` is a config-correctness defect — the operator declared a block that structurally
cannot work given the rest of their config (e.g. `model-tier` without `embeddings.modelTier.full`,
`gateway` without a base URL), and that is always fixable by editing the config, so it should be
loud. `local`'s `null` is an environment-availability question instead: the optional
`@the-40-thieves/obsidian-tc-reranker-local` package (~230 MB `onnxruntime-node`, kept out of the
root workspace on purpose) may simply not be resolvable on *this* exact deployment — not yet
published, not built in this checkout, no `localModulePath` override. Treating that identically to a
config typo would mean an operator who opts into an optional capability that happens to be
unavailable gets a hard boot crash, which is the opposite of "rerank reachable without a gateway".
So `local` degrades exactly like an absent block: `rerankWithScores` reports `not_configured`,
retrieval stays RRF-only. `doctor/checks.ts`'s `rerankerBuildableCheck` (wired with a real
resolution probe in `cli/commands/doctor.ts`) is what keeps this loud instead of silently identical
to "nothing configured". See CHANGELOG.md THE-705 (#806) for the `local` provider's own history.

## `planeRoles`: separate gateway roles for background jobs (THE-700/THE-709, #659)

`planeRoles` gives the background plane (synthesis/audit) its own `GatewayClient` with a larger
attempt budget and, separately, its own per-attempt timeout, distinct from the interactive `roles`
seam the M7 challenge tool shares. The full measured history — the Modal cold-start budget, why more
attempts beats a longer per-attempt timeout, the rejected `ping()`-based pre-warm idea, and the
370.4s-twice-12ms-apart / LiteLLM-60.8s-across-470-models measurements — is already recorded in
CHANGELOG.md under THE-700 (#659) and THE-709, plus `docs/wiki/Configuration.md` /
`docs/src/content/docs/configuration/config-reference.md` for `plane.gatewayTimeoutMs`. Check those
before re-deriving the numbers.

## ACL construction is duplicated on purpose (THE-630, #809)

`wireDomainTools` calls `buildAcls(config.acl, config.vaults)` itself rather than threading
`wireGovernance`'s already-built `acl`/`aclByVault` objects through `server-runtime.ts`'s
`wireDomainTools` call. `FolderAcl` construction is a pure function of `config`, so a second call
site is behaviorally identical to reusing governance's objects — it just re-compiles the same glob
rules once more at boot. The alternative (threading the built objects through) would push
`server-runtime.ts`'s call site over biome's 700-line file ceiling (a documented project gotcha), so
the one-time duplicate-compile cost is the traded-off cost here. `acl-build.ts` remains the single
construction *site* in the sense that matters: the one function both call sites go through.
