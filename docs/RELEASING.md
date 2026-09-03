# Releasing obsidian-tc

The release flow is **single-command staging + a human-pushed tag**. Everything before the tag is
automated and gated; the tag is the one deliberate human step — an irreversible npm/ghcr publish
should never fire from an unattended merge (THE-256). Pushing a `v*` tag fires
`.github/workflows/publish.yml`; nothing publishes on a branch push or pull request. CI
(build/test, coverage, native, plugin, docs) runs on every PR — publishing does not.

## Steps

1. **Stage the bump.** From a clean `main`:

   ```sh
   bun scripts/release.mjs <patch|minor|major|x.y.z>
   ```

   This sets the version across every `package.json` + distribution file (server, native, shared,
   `reranker-local`, `server.json`, the MCPB `manifest.json`, and the companion plugin's
   `manifest.json` / `package.json` / `versions.json` in lockstep), rolls `CHANGELOG.md`'s
   `[Unreleased]` section into the new version, refreshes `bun.lock`, runs `bun run format`, and runs
   the coherence gate. It does **not** commit, push, or tag.

   THE-944: `packages/reranker-local` is not a root workspace member (its own README explains why),
   but its version stays in lockstep too — the `publish-reranker-local` CI job's F3-style
   already-published preflight skips publishing any version already on npm, so a version that never
   moved would make every release after the owner's one-time first manual publish silently no-op.

   **The CHANGELOG coverage gate runs first**, before anything is mutated. It asserts that every
   user-visible commit since the previous tag (`feat`/`fix`/`perf`/`build`) is cited in
   `[Unreleased]`, because `release.mjs` only *renames* that section — a PR that never wrote an entry
   would otherwise ship undocumented. Each commit is attributed to a PR by `(#N)` in its own subject
   (squash merges) or through its enclosing `Merge pull request #N` commit (merge commits); a
   rebase-merged commit carries no PR number anywhere and must be cited by **every** ticket id in its
   subject instead. Genuinely internal work — CI scripts, dev tooling, pure refactors — goes in
   `NOT_USER_VISIBLE` in `release.mjs`, keyed by PR number or 8-char sha with a one-line reason,
   because the "reclassify the commit" escape hatch is only available before the commit is on `main`.

   Attributing only from subjects saw 18 of 61 user-visible commits at the v1.14.0 cut and reported
   "coverage OK" — the other 43 arrived under merge commits and were structurally invisible.

2. **Branch + PR.** Commit the staged changes on a release branch, open a PR, and let CI run:
   build/test across Linux/macOS/Windows, install-smoke, `ci-version` (version coherence + the
   tool-count headline pin), and `ci-native`. Address any autofix-bot commits (fetch/rebase before
   pushing follow-ups).

3. **Merge to `main`.**

4. **Tag.** A human pushes the annotated tag `v<x.y.z>`, firing `publish.yml`: the eight-triple
   native build matrix (linux gnu+musl x64/arm64, darwin x64/arm64, win32 x64/arm64) → npm
   (dependency order, `obsidian-tc` last) → the MCP Registry entry (`publish-registry`, gated on
   every npm package `server.json` references resolving live on npmjs — see *MCP Registry publish*
   below) → standalone binaries →
   Docker/ghcr → the `.mcpb` bundle → the companion-plugin assets → a draft GitHub Release with
   checksums. See *What a tag produces* and *Ordered npm publish* below for the details.

5. **Verify the assets** — the Release is already PUBLISHED, not a draft. `publish.yml` sets
   `draft: false` deliberately (*"releases were left as drafts, so 'Latest' went stale"*), so there
   is no publish step to perform; the tag both builds and publishes. This step is verification only:

   ```sh
   npm view obsidian-tc version                 # 11 packages must all be at the new version
   gh release view v<x.y.z> --json assets       # 11 assets: 5 binaries, plugin zip, .mcpb,
                                                # SHASUMS256.txt, and 3 loose BRAT files
   docker manifest inspect ghcr.io/the-40-thieves/obsidian-tc:<x.y.z>   # amd64 + arm64
   ```

   Two things that have misled a check here before:

   - **A RED publish job can still have shipped almost everything.** One cut went 18/19 with npm
     and ghcr both fine and a single asset missing. Read WHICH jobs failed; do not re-run blind.
   - **`sha256sum -c SHASUMS256.txt` verifies NOTHING against downloaded assets** and still exits 0.
     The manifest carries build-time paths (`./mcpb/obsidian-tc.mcpb`), which match no downloaded
     file, so `-c` reports "no file was verified" rather than a mismatch. Compare a hash directly.

6. **Confirm the registry entry (THE-940).** `publish-registry` runs mcp-publisher non-interactively
   and its own job log is the primary signal, but confirm the entry actually landed rather than
   trusting a green job in isolation (the same "red job can still have shipped almost everything, and
   a green one is not proof either" caution as step 5). Use the exact-match endpoint, not
   `?search=` (review finding G3): `?search=` is a fuzzy substring match over every registered
   server, which can both over-match (a name that merely contains the search text) and
   under-match (registry-side tokenization quirks) — it is exactly what `publish-registry`'s own
   preflight step deliberately does NOT use, for the same reason. This is that same exact-match
   endpoint, run by hand instead of by the job:

   ```sh
   curl -sS -o /dev/null -w "%{http_code}\n" \
     "https://registry.modelcontextprotocol.io/v0/servers/io.github.The-40-Thieves%2Fobsidian-tc/versions/<x.y.z>"
   ```

   **200** means `<x.y.z>` is published — pipe through `| jq .` (drop `-o /dev/null -w ...`) to
   see the full entry and confirm its `version` field. **404** means it is NOT published — not a
   stale entry, an absent one; the response body is `{"title":"Not Found","status":404,
   "detail":"Server not found"}`. Anything else (a 5xx, a connection error) means the check
   itself failed to run, not that the entry is absent — retry the curl before concluding anything.

   **Registry versions are immutable — there is no "just re-run it" fix for a bad entry.** A second
   publish attempt at the same name+version fails hard: `mcp-publisher publish` returns
   `cannot publish duplicate version` (registry v1.8.1, `internal/database/database.go`'s
   `ErrInvalidVersion`). `publish-registry`'s own preflight step already detects this exact
   condition (`GET /v0/servers/{name}/versions/{version}` — 200 means already-published) and skips
   the publish steps cleanly, so re-running the *job* after some unrelated tag-job failure is safe
   and idempotent — that is the resumed-release path it exists for, not license to re-run because a
   published entry looks wrong. If the published entry itself is wrong, the fix is the same as any
   other immutable-publish mistake in this pipeline: bump and re-tag. (The registry does expose an
   authenticated edit endpoint for an existing version; this runbook does not use it.)

7. **Update the GitHub repository description and topics.** Not automated — the registry entry
   above is a machine-readable listing, but the repo header is what a human finds it through
   first, and its tool-count headline has its own staleness history (it still said "141 tools"
   through this task). Do by hand (`gh repo edit`, or the GitHub UI) whenever
   `packages/server/test/registered-tool-count.ts`'s `REGISTERED_TOOL_COUNT` changes:

   - **Description** — keep the "N tools across M domains" phrase in lockstep with
     `REGISTERED_TOOL_COUNT` (163 as of this task) and `docs/project-facts.json`'s `domainCount`
     (31); e.g. `Obsidian Turbocharged — governed, agent-ready Obsidian MCP server. 163 tools
     across 31 domains, multi-vault native, pluggable embeddings. TypeScript + Rust.
     AGPL-3.0-only.`
   - **Topics** — review against the current stack (`ai-agents`, `mcp`, `model-context-protocol`,
     `obsidian`, `obsidian-md`, `rust`, `typescript` as of this task) and add any newly-relevant
     one; there is no automated coherence gate for topics the way there is for the tool count.

8. **Fire the directory listings (THE-945).** Not automated, and not on the critical path of the
   tag itself — the registry entry from step 6 only reaches an aggregator that scrapes it (Glama,
   PulseMCP); Smithery and mcp.so each need their own submission, and the companion plugin's
   community-store PR is separate again. Full steps, commands, and verification URLs for every one
   of them: `docs/superpowers/plans/2026-09-03-listings/checklist.md`.

## What a tag produces

- **npm** — three umbrella packages (`obsidian-tc`, `@the-40-thieves/obsidian-tc-shared`,
  `@the-40-thieves/obsidian-tc-native`) plus **eight** platform sub-packages
  (`@the-40-thieves/obsidian-tc-native-{linux-x64-gnu,linux-x64-musl,linux-arm64-gnu,linux-arm64-musl,darwin-x64,darwin-arm64,win32-x64-msvc,win32-arm64-msvc}`),
  published with npm provenance.
- **MCP Registry entry** (THE-940) — `server.json` published to
  `registry.modelcontextprotocol.io` via `mcp-publisher`, after every npm package it references
  resolves live on npmjs. See *MCP Registry publish* below.
- **Standalone binaries** — `bun build --compile` for the four platforms.
- **Companion plugin zip** — for `.obsidian/plugins/` (plus the loose `manifest.json` / `main.js` /
  `styles.css` set for BRAT).
- **`.mcpb` bundle** — the single-file MCPB server bundle.
- **Docker image** — `ghcr.io/the-40-thieves/obsidian-tc` (amd64 + arm64).
- **Draft GitHub Release** — binaries, plugin zip, and `SHASUMS256.txt`.

## MCP Registry publish (THE-940)

THE-220 committed `server.json` to the repo root against the 2025-12-11 schema, but nothing ever
published it — `publish-registry` (`publish.yml`, `needs: publish-npm`) is that automation:

1. **Preflight — is this exact name+version already registered?** `GET
   /v0/servers/{name}/versions/{version}` on the registry itself: HTTP 200 means it is (a resumed
   release after some other tag job failed) — skip the publish steps and let the job succeed; HTTP
   404 means proceed; anything else fails the job rather than guessing. Registry versions are
   **immutable** (a second publish at the same name+version fails hard — see step 6 above), so this
   is what makes *re-running the job* safe even though the underlying registry publish is a one-shot
   action. Mirrors `publish-npm`'s own F3 `already_published` classification, and every step below
   is gated on this one's output the same way.
2. **Wait for npm propagation.** The registry validates package ownership by fetching the exact npm
   **version document** — `<registryBaseUrl>/<identifier>/<version>`, e.g.
   `https://registry.npmjs.org/obsidian-tc/1.25.0` — for every npm entry in `server.json`'s
   `packages[]`, and a 404 there at publish time is a hard failure. That is a *different*,
   independently-propagating object from the packument `npm view`/`GET /<name>` fetches, so this
   polls the exact URL the registry itself builds (derived from `server.json` via `jq`, not
   hardcoded) rather than the packument, up to 10 times / 10s apart, once per `packages[]` npm
   entry — today just `obsidian-tc`.
3. **Install `mcp-publisher`.** Pinned to v1.8.1, binary + checksum (no `curl | sh`), via the
   shared `.github/actions/install-mcp-publisher` composite action — the same action
   `registry-validate` (below) uses, so the pin can only drift in one place.
4. **`mcp-publisher login github-oidc`.** Trades this job's own GitHub OIDC token for a
   short-lived registry credential; no stored secret. Needs `permissions: { id-token: write,
   contents: read }` at the job level.
5. **`mcp-publisher publish`.** Reads `server.json` from the repo root.

**`packages/reranker-local` is deliberately absent from `server.json`'s `packages[]`.** It is an
optional add-on resolved at runtime (its own README explains why), not how the server is launched,
so the registry validates nothing about it and `publish-registry`'s `needs:` stays `publish-npm`
alone. If a future change ever adds it (or any other npm package) to `server.json`'s `packages[]`,
two things move together: add that package's publish job to `publish-registry`'s `needs:` list, and
know that step 2's propagation wait needs **no corresponding edit** — it already loops every
`packages[]` npm entry, because it derives the list from `server.json` rather than a hardcoded name.
That claim is true precisely BECAUSE the encoding is scope-aware (THE-940 review finding G1):
reranker-local's actual npm package is `@the-40-thieves/obsidian-tc-reranker-local`, a SCOPED
name, and the wait loop encodes only the `/` in an identifier (leaving a leading `@` literal —
matching the registry's own npm validator, which builds the version-document URL with Go's
`url.PathEscape`) rather than percent-encoding `@` too. An earlier version of this loop used
jq's `@uri`, which encodes every RFC 3986 reserved character including `@`. npm's registry
happens to tolerate that over-encoding today (measured: both forms return 200) — but relying on
CDN leniency instead of building the URL the registry's own validator actually builds is exactly
the kind of "works by accident" this runbook should not promise. `scripts/check-
npm-identifier-encoding.test.mjs` pins the corrected shape against both an unscoped and a scoped
identifier, run against the real, embedded `jq` filter rather than a reimplementation.

Gated on `github.event_name == 'push'` only — unlike every other job downstream of `build-native`,
it has no `workflow_dispatch`/`dry_run` path at all, because a dispatched dry run never has a real
npm-published version for the registry to point at.

PR-time pre-flight: `ci-server.yml`'s `registry-validate` job runs `mcp-publisher validate
server.json` on every PR (no OIDC, no npm check — pure schema/business-rule validation; there is
no `--dry-run` flag, this is the closest equivalent). It retries with backoff on a network error or
a 5xx, but fails immediately on a 4xx (the registry actually rejecting `server.json`'s content —
not transient). **This job is advisory only and must never be promoted to a required status
check** — unlike every currently-required check, it depends on a third-party service's uptime,
which has nothing to do with whether a given PR's own code is correct.

## Ordered npm publish (THE-224, revised by THE-574)

npm publishes are immutable: a published version cannot be overwritten or moved backward, only
deprecated. The release must therefore never be able to leave a version-skewed set resolvable by
installers.

THE-224 originally solved this by publishing the umbrellas to a holding `pending` dist-tag and
promoting them to `latest` at the end. **That design could not survive trusted publishing**: OIDC
authorises `npm publish` only, so `npm dist-tag add` fell back to token auth and failed `EOTP` on
every release (THE-574). Worse, it is on a deadline — npm's 2026-07-08 changelog puts package
*management* actions first in line as 2FA-bypass tokens are withdrawn from early August 2026.

The `pending` tag is gone. Safety now rests on two structural facts instead of a tag mutation:

1. **Every inter-package dependency is exact-pinned, never ranged.** `scripts/pin-workspace-deps.mjs`
   rewrites `workspace:*` to the concrete version before publishing, so `obsidian-tc@X` depends on
   exactly `-native@X` and `-shared@X`, and `-native@X` `optionalDependencies` exactly the eight
   `-native-<triple>@X`. **Nothing resolves a sub-package through a dist-tag.** Where `latest` points
   on the sub-packages cannot affect any install, and no already-installed release can drift onto a
   half-published version.
2. **`obsidian-tc` publishes last.** It is the only package installed by name, so its `latest` is the
   only one that matters. If the sequence dies before it, `npm install obsidian-tc` keeps resolving
   the previous release, wholly intact.

Together those give the property `pending` was there to provide, with no step that CI cannot perform.

1. **Preflight (F3).** Classify the target version on npm before publishing: **none** published →
   fresh release; **all** published → resumed release, skip the npm-mutating steps and let the
   pipeline finish (THE-575); **some** published → hard fail, because that is either a mid-publish
   death or a tag cut without bumping, and guessing there is how a skewed release gets cemented.
2. **Publish platform sub-packages.** The eight leaf `@the-40-thieves/obsidian-tc-native-*` packages
   publish via `napi pre-publish`, which also pins the native umbrella's `optionalDependencies` to
   exact versions. They are unreferenced until an umbrella that pins them is published.
3. **Publish umbrellas in dependency order, `obsidian-tc` last** — `-native`, `-shared`, then
   `obsidian-tc`. Stable versions go to `latest`; **prereleases go to `next`**, since a bare
   `npm publish` defaults to `latest` regardless of semver and would drag the stable tag onto a
   prerelease.

## Recovery

- **Re-cutting a failed release.** Publishing is immutable (no rollback). If a tag's publish fails
  partway, fix on `main` and delete + re-create the tag at the fixed HEAD; never reuse a partially
  published version number.
- **A release that failed *after* publishing** is resumable: re-run the workflow. The F3 preflight
  recognises the fully-published case and skips straight to the artifact jobs (THE-575). Use a
  **full** `gh run rerun <run-id>`, never `--failed` — see `RELEASE-SIGNING.md` for why.
- **The publish sequence died partway** (e.g. `-native` and `-shared` up, `obsidian-tc` not).
  `obsidian-tc@latest` still points at the previous release, so installers are unaffected. The
  published sub-versions are orphaned and harmless: nothing references them, because the umbrella
  that would pin them was never published. Bump and re-tag.
- **Inspect a release.** `npm view obsidian-tc dist-tags` shows where `latest` and `next` point.

## Caveat: brand-new package names

npm forces the first published version of a new package name onto `latest` regardless of `--tag`.
That is now the desired behaviour for a stable release, but it means a **prerelease** of a
brand-new package name will land on `latest` despite `--tag next`. When introducing a new package
name in a prerelease, publish a throwaway version first or accept the initial `latest`.

## Not adopted: npm staged publishing

npm's own staged publishing (GA May 2026) is the registry-native version of THE-224's staging idea
and was evaluated for THE-574. It fits OIDC by design — `npm stage publish` needs no 2FA and works
with any token type, while `npm stage approve <stage-id>` requires 2FA and **cannot** be performed by
an OIDC token, deliberately, since human approval is the point. Nothing is publicly resolvable until
approved, which is stronger isolation than `pending` ever gave.

It was not adopted because approval is **per staged package**: a release would need eleven separate
2FA approvals, in dependency order, with the ordering footgun that made the promote step fragile in
the first place. Ordered publishing gives the same install-time safety with zero human steps. If
proof-of-presence on releases becomes a requirement, this is the mechanism to switch to — it needs
npm CLI ≥ 11.15.0 and Node ≥ 22.14.0, and the trusted publisher must be reconfigured to
*stage-only* so a plain `npm publish` from CI is rejected.

## Invariants enforced in CI

- All version strings agree (`scripts/check-version-coherence.mjs`).
- The companion plugin's manifest version equals the repo version and `versions.json` lists it.
- The documented tool-count headline matches the registered surface (THE-306).
- `packages/server/package.json`'s `mcpName` matches `server.json`'s `name` and `server.json`'s
  `description` stays within the registry's 100-character cap (`scripts/check-mcp-name.mjs`,
  THE-940).

## Community-store submission (companion plugin)

The plugin is BRAT-installable from any tagged release (the loose 3-file set is attached). Formal
Obsidian community-store listing is a one-time manual PR to
[`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases); because the plugin
lives in a monorepo subfolder, copy its `manifest.json` + `versions.json` to the submission as the
store tooling expects them at the repo root.
