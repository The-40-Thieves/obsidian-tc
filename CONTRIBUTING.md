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
- `docs/` — Astro Starlight documentation site.
- `examples/` — Example integrations (Claude Desktop, Claude Code, Cursor, Docker, agents).

There is no Python in the repo. A Python ML sidecar was once reserved for V2 retrieval intelligence; it is **out of scope** for obsidian-tc.

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
bun install              # installs all workspace deps (native falls back to pure-JS)
bun run build            # builds shared + native + server + plugin (native needs Rust)
bun run test             # runs the workspace test suites
```

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

Point your config's vault `path` at a scratch vault — do not use your real vault during development. To exercise the HTTP transport, enable `transports.http` in your config; it binds `127.0.0.1` by default, and an unauthenticated server refuses to bind a non-loopback host.

### Running the plugin in Obsidian

```bash
cd packages/plugin
bun run dev              # esbuild watch mode
```

Symlink `packages/plugin/dist/` into your test vault's `.obsidian/plugins/obsidian-tc/` directory. Enable the plugin in Obsidian Community Plugins. Restart Obsidian on manifest changes.

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

1. CI workflows green (`ci-server`, `ci-plugin`, `ci-native` × 4 platforms, `ci-version`).
2. At least one review from a maintainer.
3. Conventional Commits format on the PR title (used to generate the changelog).
4. Tests added for new behavior. Coverage may regress but should not regress meaningfully.
5. Documentation updated if the change is user-visible — README, `docs/`, or inline comments depending on scope.

PRs that miss required items will be flagged but not auto-closed. Maintainers help bring them across the line.

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

## Working with Issues

Issues are triaged on a rolling basis. Labels indicate state:

- `triage`: not yet reviewed by a maintainer.
- `good-first-issue`: small, well-scoped, suitable for a first contribution.
- `help-wanted`: open for contribution.
- `bug`, `enhancement`, `docs`, `question`, `discussion`: type.
- `blocked`: external dependency or upstream issue blocking progress.
- `wontfix`: intentionally not pursuing; explanation in comments.

Before starting work on a non-trivial issue, comment that you are picking it up. This avoids duplicate effort.

## Release Process

Releases are coordinated by maintainers; contributors do not need to drive them. Briefly:

1. Run `bun run release <patch|minor|major>` (`scripts/release.mjs`). It sets the version across every `package.json` plus the distribution metadata (`server.json`, `manifest.json`), rolls the CHANGELOG `[Unreleased]` → `[next] - <date>`, refreshes `bun.lock`, and runs the version-coherence gate. It requires a non-empty `[Unreleased]` section, and the Obsidian plugin manifest is excluded (the plugin versions on its own cadence).
2. Open a release PR, get reviews, merge.
3. A maintainer pushes tag `v<x.y.z>`; `publish.yml` builds the 4-platform native matrix and publishes to npm (`pending` → `latest`), pushes the GHCR image, and drafts a GitHub Release.
4. Plugin-store submission is a separate PR to `obsidianmd/obsidian-releases` for new minor versions.

The full runbook lives at `docs/G2.5-release-engineering.md` §9.

## License

obsidian-tc is licensed under [Apache 2.0](./LICENSE). By submitting a contribution, you certify that you have the right to submit it under that license. See the [Developer Certificate of Origin](https://developercertificate.org/) for the formal statement; signed-off commits are appreciated but not required.

## Getting Help

- GitHub Discussions for design questions, integration questions, and "is this the right approach" questions.
- GitHub Issues for bug reports and feature requests.

We aim to respond within a few days. For security issues, follow [`SECURITY.md`](./SECURITY.md) for the disclosure process.
