# Contributing to obsidian-tc

Thank you for your interest in obsidian-tc. This document explains how to set up a development environment, work with the polyglot codebase, follow the contribution conventions, and get changes merged.

If you have not yet read it, start with [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the system map and `docs/G2.1-tools.md` for the tool surface specification.

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). Be respectful, assume good faith, give people the benefit of the doubt. Disagreement is welcome; rudeness is not.

## Security Issues

Do not file security issues as public GitHub Issues. Report them per [`SECURITY.md`](./SECURITY.md).

## Project Layout

obsidian-tc is a polyglot monorepo. The packages are:

- `packages/server/` — TypeScript MCP server. Bun runtime.
- `packages/plugin/` — TypeScript Obsidian companion plugin.
- `packages/native/` — Rust native module via napi-rs.
- `packages/shared/` — Shared TypeScript types and Zod schemas.
- `services/` — Python sidecar services (`bge-m3-service`, `docs-ingest`, `qwen-tei`). Optional at
  runtime; the server falls back when they are not reachable.
- `docs/` — Astro Starlight documentation site.
- `examples/` — Example integrations (Claude Desktop, Claude Code, Cursor, Docker, agents).

Python is confined to `services/` and is not part of the server, plugin, shared, or native build.
You do not need Python to work on those. The V2 retrieval-intelligence ML sidecar is a separate,
still **out-of-scope** idea and is not what lives here — `services/` holds embedding, reranking and
docs-ingest workers, covered by their own CI job (`ci-model-service.yml`).

## Development Setup

You need two toolchains for full development: Node/Bun and Rust. You can skip Rust if you only work on server/plugin code — the native module falls back to a pure-JS implementation.

### Required

- **Bun** `>=1.1.0` (CI pins 1.3.x). Install from <https://bun.sh>.
- **Node** `>=24 LTS`. Required for the server test runner (it uses `node:sqlite`) and plugin tooling. Install via [`fnm`](https://github.com/Schniz/fnm), [`mise`](https://mise.jdx.dev/), or your preferred version manager.
- **Git**. Any recent version.

### Required for native module work

- **Rust toolchain** via [rustup](https://rustup.rs). Stable channel. Add cross-compile targets as needed.
- **napi-rs CLI** `>=3` (`@napi-rs/cli`). Auto-installed via `bun install`.
- For Linux ARM cross-compilation: `cargo install cross --locked`.

### One-command bootstrap

```bash
git clone https://github.com/the-40-thieves/obsidian-tc.git
cd obsidian-tc
bun install              # installs all workspace deps (native falls back to pure-JS); also
                          # configures the merge driver and a DCO sign-off git hook (both idempotent)
bun run build            # builds shared + native + server + plugin (native needs Rust)
just test                # runs the workspace test suites the way CI does (see `just test` in the
                          # justfile for why packages/server runs under Node specifically, not `bun run test`)
```

Toolchain mismatch? `just doctor` compares `bun`/`node`/`python3`/`rustc` on your PATH against this repo's pins in `mise.toml` (`mise install` already resolves them if you use mise).

No Rust toolchain? Skip the native build and rely on the pure-JS fallback:

```bash
bun run --filter='!@the-40-thieves/obsidian-tc-native' build   # shared + server + plugin
```

To build the native module locally (your platform only):

```bash
cd packages/native
bun run build
```

This produces a `.node` file in the package directory. The umbrella `@the-40-thieves/obsidian-tc-native` loader picks it up automatically on the next test run; without it, the pure-JS fallback is used.

## Working with the Codebase

### Starting the server in dev mode

```bash
cd packages/server
bun run dev              # auto-reload on file changes (stdio transport)
```

Point your config's vault `path` at a scratch vault — do not use your real vault during development. `examples/scratch-vault/` ships a tiny, entirely synthetic one for exactly this (paired with `examples/config.scratch.json`; copy it and fill in an absolute path). To exercise the HTTP transport, enable `transports.http` in your config; it binds `127.0.0.1` by default, and an unauthenticated server refuses to bind a non-loopback host.

### Running the plugin in Obsidian

```bash
cd packages/plugin
bun run dev              # esbuild watch mode
```

Symlink `packages/plugin/dist/` into your test vault's `.obsidian/plugins/tc-bridge/` directory —
`just link-plugin <path-to-vault>` does this for you (building the plugin first if needed; run it
again after any `manifest.json` change). For example, against the scratch vault above:
`just link-plugin examples/scratch-vault`. Enable the plugin in Obsidian Community Plugins.
Restart Obsidian on manifest changes.

### Running the native module tests

```bash
cd packages/native
cargo test               # Rust unit tests
```

### Forcing the pure-JS fallback

To exercise the pure-JS fallback path without removing the native module:

```bash
OBSIDIAN_TC_FORCE_JS_FALLBACK=1 bun run test
```

CI runs both the native and fallback paths.

## Code Conventions

### Languages

- **TypeScript**: strict mode; no implicit `any`; no `any` without a justification comment. Linted and formatted by [Biome](https://biomejs.dev) — `bun run lint` (check) and `bun run format` (write).
- **Rust**: `rustfmt` and `clippy` clean. `#![deny(unsafe_code)]` outside the napi-rs FFI boundary.
- **JSON**: Biome-formatted (2-space). YAML and Markdown are kept tidy but are not auto-formatted by Biome.

### Inline commentary

Inline comments state **invariants and why**, present-tense, impersonal. Target ~6 lines per
block. Say what must hold and why the code is shaped this way — not who found it or when:

```ts
// Sink assignment happens before the first tick, so a call in the constructor never observes
// `undefined` here. Do not move this behind the ready check below.
```

Deep rationale — measurements, correction history, decision narratives, alternatives considered —
belongs in `docs/design/` notes, `docs/adr/`, or `docs/superpowers/specs/`, not in the source. The
comment carries a one-line summary and a pointer to where the substance lives:

```ts
// Chosen over a per-row trigger for write-amplification reasons; see docs/adr/0007-....md.
```

Not allowed in `packages/*/src`:

- **Dated banners** — `CORRECTED <date>`, `VERIFIED <date>`, `MEASURED <date>`, `DECIDED <date>`,
  `RE-CHECKED <date>`. A comment is either true now or it is wrong; a date does not fix that, and
  the correction history belongs in git blame and the linked doc, not restated inline every time
  someone rereads the function.
- **First-person narrative** — "I found", "we decided", "turns out". Write what is true of the
  code, not the story of how you got there.
- **Measurement tables** — benchmark numbers, before/after comparisons. These drift the moment the
  code around them changes and nothing re-runs them; put pinned measurements in a doc where a
  reader expects a number to need re-checking, not in a comment where it reads as still current.

Ticket IDs (`THE-xxx`) are a provenance suffix, not a substitute for a self-contained comment —
allowed only when the comment already stands on its own without the ticket, or when it points at a
public doc. `THE-xxx` refers to an issue tracker that is private to this project's maintainers;
The decisions index (published on the docs site under Contributing, generated by
`bun run docs:decisions-index`, never committed) resolves each ticket referenced from source
to a public one-line summary and, where one exists, the doc or CHANGELOG entry carrying the real
rationale — so a reader without tracker access is never stuck at a dead end.

**Exemptions** — this policy does not apply to:

- Migration files (`packages/server/src/migrations/*.sql`) and their generated embedding
  (`packages/server/src/db/migrations-embedded.ts`). Both are checksum-pinned once applied and
  uneditable by design; their comments are a historical record, not living documentation.
- `docs/`, `CHANGELOG.md`. These are exactly the narrative, dated, first-person forms the policy
  above relocates rationale *to* — the rule constrains `packages/*/src`, not where the rationale
  ends up.
- Test-fixture strings — a fixture asserting on comment *text* (e.g. a parser test) needs that text
  to look like whatever it is testing, dated banners included.

**Why relocate instead of delete.** The rationale density in this codebase's comments is
deliberate and load-bearing — it is what makes agent-assisted changes safe in a system with this
much accumulated, non-obvious behavior. This policy does not thin that out; it moves the
narrative, measurement, and correction-history weight to `docs/` where it can be found, updated,
and read on its own, and leaves the comment doing the one job a comment is actually read for in
the middle of changing code: what has to stay true, and why.

### Commits

Conventional Commits format.

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.

Scopes match the package directory or a cross-cutting concern. Examples: `feat(server): add bulk_create_notes tool`, `fix(native): handle empty input to cosine`, `docs(architecture): clarify IPC contract`.

Breaking changes append `!` after the scope or include a `BREAKING CHANGE:` footer.

### Branches

Trunk-based with short-lived feature branches. Branch from `main`, name as `<type>/<short-description>` (e.g. `feat/bulk-notes-tool`). Rebase on `main` before opening a PR.

### Pull Requests

Open PRs against `main`. Use the PR template. For merge:

1. CI workflows green (`ci-server`, `ci-plugin`, `ci-native` (3 build platforms + musl cross-build validation), `ci-docker`, `ci-version`, `dco`).
2. At least one review from a maintainer.
3. Conventional Commits format on the PR title (used to generate the changelog).
4. Tests added for new behavior. Coverage may regress but should not regress meaningfully.
5. Documentation updated if the change is user-visible — README, `docs/`, or inline comments depending on scope.
6. A release-note fragment if the change is user-visible: add `changes/<short-slug>.md` (see [Release notes](#release-notes-changes-fragments)). Do not edit `CHANGELOG.md`'s `[Unreleased]` block.

PRs that miss required items will be flagged but not auto-closed. Maintainers help bring them across the line.

### Generated files and merge conflicts

Two PRs that both touch a generated file conflict on it by construction, so this repo avoids
committing anything that moves whenever an unrelated file moves:

| artifact | how it is handled |
|---|---|
| `TREE.md` counts and the dependency graph | not committed. `bun run map` writes `generated/tree-map.md` and `generated/dependency-graph.json` (gitignored). `TREE.md` is hand-written prose. |
| decisions index | not committed. Generated into the docs site at build (`bun run docs:decisions-index`). |
| docgen marker regions (tool catalog, config reference, metrics, error catalog, wiki pages) | committed **empty**. `bun run docgen:render` fills them at docs build and wiki publish; `bun run docgen:render -- --reset` empties them again. CI fails if a region is committed filled. |
| tool count and domain count in prose | not stated anywhere (`docgen:facts-check` forbids it). The registered tool names live in `packages/server/test/registered-tools.txt`, one per line. |
| `CHANGELOG.md` `[Unreleased]` entries | one file per change in `changes/`, folded in at release. |
| config JSON Schema, `migrations-embedded.ts` | still committed (they are consumed without a build step), so they can still conflict: see below. |

`packages/server/src/db/migrations-embedded.ts` is the one generated file two PRs can still both
change (each adds a migration). `.gitattributes` names a `regen` merge driver for it
(`scripts/merge-drivers/regen.mjs`), which merges the two sides as data and re-renders through the
generator. `bun install` registers the driver in your clone's git config (`bun run check:merge-driver`
confirms it), so a local `git merge` or `git rebase` resolves it with no manual step.
**GitHub ignores `.gitattributes` merge drivers** in its server-side mergeability check and in the
web conflict editor, so such a PR can still show "This branch has conflicts" on GitHub: merge or
rebase `main` locally, and the driver resolves it. The same applies to a hand-written
`registered-tools.txt` or a manifest line that two PRs both append: those are human-authored and
resolve like any other text conflict (keep both lines, sorted).

### Release notes (`changes/` fragments)

A user-visible change adds `changes/<short-slug>.md`:

```markdown
---
type: Changed
---
- **Lead sentence.** What changed and what a user must do about it.
```

`type` is one of `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`. The body is
verbatim CHANGELOG markdown; do not write the PR number. The release derives it from the merge history and
appends `(#N)` to the first bullet, because its coverage gate looks for that number; a fragment that
already cites `(#N)` is left as written. A change to the type, default or constraint of an existing config key also
adds `config-schema-change: path.to.key` to the front matter. `bun run check:changes` validates
fragments; `scripts/release.mjs` folds them into the release section and deletes them. See
`changes/README.md`.

### Testing Expectations

- **Server**: tests live under `packages/server/test/` as `*.test.ts`, run with [Vitest](https://vitest.dev) under Node — `bun run test`, or `node ./node_modules/vitest/vitest.mjs run` to match CI (the suite needs Node's `node:sqlite`, which Bun does not provide).
- **Native**: Rust unit tests live in `#[cfg(test)]` modules — `cargo test`.
- **Plugin**: exercised through the server integration suite; document manual test steps in PRs that touch plugin behavior.
- **Pure-JS fallback parity**: any new Rust function must ship a TypeScript fallback that passes the same tests. See the performance budget in `docs/G2.5-release-engineering.md` §4.

## Adding a New Tool

Tools are defined with `defineTool` and registered onto the shared `ToolRegistry`, which owns the whole dispatch pipeline (validation -> scopes -> folder ACL -> read-only -> idempotency -> throttle -> HITL -> handler -> response governor -> audit). A handler never re-implements those gates; it declares what it needs and returns plain data.

A tool lives in its milestone domain under `packages/server/src/tools/m<N>/<domain>-tools.ts`:

```ts
import { VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { defineTool } from "../m1/define"; // a tool that lives in m1/ imports "./define" instead

export const myTool = defineTool({
  name: "do_thing",
  description: "One-line, agent-facing description of what it does and when to use it.",
  inputSchema: z.object({ vault: VaultId, path: VaultPath }).strict(),
  requiredScopes: ["read:notes"], // verb-bucket scopes; dispatch enforces them
  // destructive: true,           // opt into the HITL elicit floor for mutating ops
  handler: (input, ctx) => {
    // ctx: { caller, grantedScopes, vaultId, db, acl, ... }. Resolve + ACL-check paths via the
    // vault helpers (normalizeVaultPath / resolveVaultPath / enforcePathAcl); return plain data.
    return { ok: true };
  },
});
```

Register it in the domain's `register<M>Tools` (e.g. `packages/server/src/tools/m1/index.ts`), add a `*.test.ts` under `packages/server/test/`, and document it (or rely on the auto-generated reference under `docs/src/content/docs/tools/`). See `docs/G2.1-tools.md` for the scope/ACL/HITL conventions and the full tool surface.

### Adding a Tool Domain

A whole new tool *domain* (a new `packages/server/src/tools/m<N>/` family, not one more tool in an
existing one) is a bigger commitment than a single tool: it grows the surface every gate in
`test/tool-count.test.ts` and `test/tool-facade-domain-coverage.test.ts` counts, the m7-style
metadata parity snapshots, and `docs/G2.1-tools.md`'s domain list. Before opening that PR:

- **State the user.** Who calls this, and through what client? "An agent might want this" is not a
  user; a named workflow or a linked usage report is.
- **Bring usage evidence, or say there is none.** The `toolFacade.profile: "core"` curated set
  (`packages/server/src/mcp/tool-profiles.ts`'s `NON_CORE_TOOL_NAMES`, i.e. the tools `core`
  excludes) is informed by a real usage report — an `episode_stats` export over recorded
  `call_capability` calls, filed as a GitHub issue with the counts attached (see issue #877 for the
  shape: distinct tools called, calls per tool, the zero-call remainder). Point at that kind of
  artifact, or an equivalent telemetry export from your own deployment, when you have one — but read
  #877's own lesson first: it names only individual tools as confirmed zero-call, never whole
  families, and a family absent from a usage report is not the same claim as a family confirmed
  unwanted (the same reporter separately praised a tool, in #879, that a hasty first draft of this
  policy would have miscategorized from #877's silence alone).
- **Default to `full`, not `core`.** A new domain is visible/callable under the default
  `toolFacade.profile: "full"` like everything else; it joins `core`'s curated set only when the
  usage evidence above supports it, or when it shares the structural shape (pure filesystem, no
  live-plugin dependency, not a memory/triad/catalog/health/HITL dependency) the existing `core` set
  is curated on. Moving a tool INTO `core` later, once it earns evidence, is a small, reviewable
  diff; moving one OUT after operators start relying on it is not.

## Working with Issues

Issues are triaged on a rolling basis. Labels indicate state:

- `triage`: not yet reviewed by a maintainer.
- `good-first-issue`: small, well-scoped, suitable for a first contribution.
- `help-wanted`: open for contribution.
- `bug`, `enhancement`, `docs`, `question`, `discussion`: type.
- `blocked`: external dependency or upstream issue blocking progress.
- `wontfix`: intentionally not pursuing; explanation in comments.

Before starting work on a non-trivial issue, comment that you are picking it up. This avoids duplicate effort.

## Branch Protection and Required Checks

`main` is protected. A pull request cannot merge until every required check reports success.

**Read the live list rather than trusting a copy of it** — this file has been wrong before, and a
number in prose is exactly what goes stale:

```bash
gh api repos/The-40-Thieves/obsidian-tc/branches/main/protection/required_status_checks \
  --jq '.contexts[]' | sort
```

The policy that set governs, which is stabler than the set itself:

| group | what is required |
| -- | -- |
| tests | the **whole `build-test` matrix** — ubuntu, ubuntu-24.04-arm, macos, windows — plus `bun-smoke` |
| static analysis | `lint`, `typecheck`, `drift-gate` |
| CodeQL (advanced setup, `codeql.yml`) | `CodeQL` and every `Analyze (…)` leg |
| supply chain | both `Socket Security` checks, `cargo-deny` |
| secrets / leaks | `gitleaks`, `vault leak (structural)` |
| workflow safety | `actionlint (…)`, `no untrusted context in shell steps` |
| source hygiene | `no NUL bytes in tracked text`, `typos (source + docs spelling)`, `lychee (internal link rot)`, `config threading`, `version-coherence`, `dco-check` |

`ubuntu-24.04-arm` is required deliberately, not for symmetry: the repo ships an aarch64 binary,
production runs Ampere, and `vec.ts` documents a measured retrieval divergence between aarch64 and
x86_64 on the same commit.

### The test suite IS required — and how that became possible

It was not always. `build-test`, `lint`, `bun-smoke` and `drift-gate` used to be **path-filtered**,
and GitHub treats a required check that never reports as *"Expected — waiting for status"*, blocking
the pull request forever — so requiring one would have deadlocked every docs-only PR.

THE-599 removed the `paths:` filters from `ci-server.yml` and `ci-docgen.yml` precisely so these
could be required. That is why the repo's `CLAUDE.md` calls both workflows *"deliberately
unfiltered"* and warns never to re-add a filter: doing so would silently un-require the test suite
by making its checks path-conditional again.

The umbrella-job workaround this section used to describe — an always-running job that
short-circuits to success when its paths are untouched — is **no longer necessary**. Do not build it.

### Deliberately not required

* **`bun-audit`, `cargo-audit`, `osv-scanner`, `opengrep-full-scan`** — all `continue-on-error` by design (see `ci-security.yml`): a newly disclosed transitive advisory should *surface* without blocking unrelated work. They show as failing in `gh pr checks` while the PR stays mergeable. Requiring them would convert an advisory signal into a merge blocker the author cannot fix.
* **`semgrep-cloud-platform/scan`** — a third-party app. A vendor outage would block every merge, and CodeQL plus `opengrep` already cover this ground.

The jobs above are non-blocking by construction. A separate set of jobs is the opposite: they hard-gate (no `continue-on-error`, a failure is a real red X) yet are still outside the required-checks list above. That list is not uniform in why:

* **`acl-audit`, `perf`** (`ci-server.yml`) — each job's own comment says so directly: "intentionally not (yet) a required status check ... promote it once it has run green for a while." `perf` additionally only runs on `push` to `main` (never `pull_request`), so listing it as required would deadlock every PR the same way the pre-THE-599 path-filtered jobs did.
* **`native-contract`** (`ci-server.yml`) — the guard against the exact crash class in #855: every other server test lane runs against the JS fallback (`--ignore-scripts`, or `ci-native.yml`'s `fallback-test`), whose types are more lenient than the compiled Rust binding's, so a caller that violates the native signature passes every one of those lanes and crashes on a real install that ships the prebuilt addon. This job builds the addon for real and asserts it loaded. It should be promoted to required; doing so is a branch-protection API change for a maintainer to make separately, not part of this documentation pass.
* **`reranker-local`** (`ci-server.yml`) — closes the gap that the optional local-reranker package's tests ran in no CI workflow at all before it existed (THE-705 round 2). Newly added, same not-yet-promoted status as `acl-audit`.
* **`trufflehog`, `checkov`, `hadolint`** — hard-gate, and no job comment in this repo documents a reason for their absence from the required set, unlike the rows above. `trufflehog` is the one with a known fragility: it verifies findings against the issuing provider over the network, so it fails OPEN when that provider is unreachable (documented in its own step comment in `ci-security.yml`), and it has one recorded false-positive incident there — the `lob` detector verifying a pytest function name as a live key. `checkov` and `hadolint` carry no comparable documented issue.

### Merge queue (maintainers)

The merge queue is **not enabled**; this is the runbook for when a maintainer turns it on. It
removes the "rebase, wait for CI, lose the race to the next merge" cycle that `strict: false` only
partly avoids, because each queued PR is tested against `main` plus the PRs ahead of it.

Prerequisites, already in this repo: every workflow that owns a required check lists `merge_group:`
next to `pull_request:` (`ci-server`, `ci-docgen`, `ci-quality`, `ci-security`, `ci-version`,
`dco`). A required check whose workflow does not fire on `merge_group` never reports and stalls the
queue entry until it times out. `dco-check` is skipped on `merge_group` (there is no PR range to
check) and a skipped job satisfies a required check. CodeQL runs from `codeql.yml` (advanced
setup, because default setup cannot run on `merge_group`); its job name `Analyze (<language>)` must
keep matching the four required `Analyze (...)` contexts. **Not covered by this repo:** the `CodeQL`
results check (created by GitHub when the SARIF uploads) and `Socket Security` (the Socket app), so
confirm on the first queue entry that they report on the `gh-readonly-queue/main/*` ref; if one
does not, remove it from the required list before enabling the queue rather than after.

Steps (repository admin, GitHub web UI; labels move, so match by name):

1. Repository **Settings** -> **Branches** -> the existing `main` branch protection rule -> **Edit**.
   (If you prefer a ruleset: **Settings** -> **Rules** -> **Rulesets** -> **New ruleset** -> **New
   branch ruleset**, target `main`, and use the **Require merge queue** rule there. Rulesets and the
   classic rule both apply; do not configure the queue in both.)
2. Tick **Require merge queue**. The option is only offered where the plan and repository allow it
   (public repositories owned by an organization). If it is missing, the plan does not include it.
3. Set: **Merge method** = *Merge commit* (what `main` history uses today: `Merge pull request #N`,
   from which the release coverage gate recovers the PR number); **Build concurrency** 1 to start; **Minimum/maximum group
   size** 1 (no batching until the queue is proven); **Only merge non-failing pull requests** on;
   **Status check timeout** above the slowest required leg (the `build-test` matrix).
4. Leave the required status checks list as it is (`gh api repos/The-40-Thieves/obsidian-tc/branches/main/protection/required_status_checks --jq '.contexts[]'`).
5. Save, then queue one low-risk PR and watch that every required check reports on the
   `gh-readonly-queue/main/...` ref. Merging then happens from the **Merge when ready** button
   instead of **Merge**.

To back out: untick **Require merge queue** in the same place. Nothing in the workflows needs
reverting; the extra `merge_group:` triggers are inert without the queue.

### Settings, and why

* **`strict: false`** — a PR need not be rebased onto the latest `main` before merging. With frequent merges, `strict: true` forces a rebase-and-rewait cycle on every PR that lands second.
* **`enforce_admins: false`** — admins can override. On a repo with few maintainers, enforcing it risks locking out the only person able to land an emergency fix.
* **No required reviews** — self-approval is not possible on GitHub, so requiring one review would block every solo-authored PR outright.
* **Force pushes and branch deletion are blocked** on `main`.

## Release Process

Releases are coordinated by maintainers; contributors do not need to drive them. Briefly:

1. Run `bun run release <patch|minor|major>` (`scripts/release.mjs`). It sets the version across every `package.json` plus the distribution metadata (`server.json`, `manifest.json`), rolls the CHANGELOG `[Unreleased]` → `[next] - <date>`, refreshes `bun.lock`, and runs the version-coherence gate. It requires a non-empty `[Unreleased]` section, and the Obsidian plugin manifest is excluded (the plugin versions on its own cadence).
2. Open a release PR, get reviews, merge.
3. A maintainer pushes tag `v<x.y.z>`; `publish.yml` builds the eight-triple native matrix (linux gnu+musl x64/arm64, darwin x64/arm64, win32 x64/arm64) and publishes to npm (`pending` → `latest`), pushes the GHCR image, and drafts a GitHub Release.
4. Plugin-store submission is a separate PR to `obsidianmd/obsidian-releases` for new minor versions.

The full runbook lives at `docs/G2.5-release-engineering.md` §9.

## License and Sign-off (DCO)

obsidian-tc is licensed under [AGPL-3.0-only](./LICENSE). A separate commercial-exception license may also be available for organizations that cannot meet the AGPL's network-copyleft terms; if that applies to you, open a discussion to ask — the terms are decided case by case and are not published here.

Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/) (DCO), not a CLA. By signing off a commit you certify the DCO: that you wrote the change or otherwise have the right to submit it under the project's license.

**Sign-off is required.** Every non-merge commit in a pull request must carry a `Signed-off-by:` trailer whose name and email match the commit author, e.g.:

```
Signed-off-by: Jane Doe <jane@example.com>
```

Add it automatically with `git commit -s` (configure `git config user.name` / `user.email` first). `bun install` also installs a local `prepare-commit-msg` git hook (`scripts/setup-dco-hook.mjs`) that appends the same trailer to every commit automatically, so forgetting `-s` no longer produces a commit `dco` will reject — it leaves alone any `prepare-commit-msg` hook you already have. To sign off a branch of existing commits, run `git rebase --signoff main` and force-push. The `dco` CI check verifies this on every PR and fails with a remediation hint if a commit is missing the trailer; merge commits are exempt.

## Getting Help

- GitHub Discussions for design questions, integration questions, and "is this the right approach" questions.
- GitHub Issues for bug reports and feature requests.

We aim to respond within a few days. For security issues, follow [`SECURITY.md`](./SECURITY.md) for the disclosure process.
