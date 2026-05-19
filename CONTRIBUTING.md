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
- `packages/sidecar/` — Python ML sidecar. V2 only, optional.
- `docs/` — Astro Starlight documentation site.
- `examples/` — Example integrations (Claude Desktop, Claude Code, Cursor, Docker, agents).

## Development Setup

You need three toolchains for full development. You can skip Rust if you only work on server/plugin code; you can skip Python entirely unless you touch the V2 sidecar.

### Required

- **Bun** `>=1.1.0`. Install from <https://bun.sh>.
- **Node** `>=22 LTS`. Required for plugin tooling. Install via [`fnm`](https://github.com/Schniz/fnm) or [`mise`](https://mise.jdx.dev/) or your preferred version manager.
- **Git**. Any recent version.

### Required for native module work

- **Rust toolchain** via [rustup](https://rustup.rs). Stable channel. Add cross-compile targets as needed.
- **napi-rs CLI** `>=2`. Auto-installed via `bun install`.
- For Linux ARM cross-compilation: `cargo install cross --locked`.

### Required for V2 sidecar work

- **Python** `>=3.11`.
- **Maturin** `>=1.5`. `pipx install maturin`.

### One-command bootstrap

```bash
git clone https://github.com/the-40-thieves/obsidian-tc.git
cd obsidian-tc
bun install              # installs all workspace deps, native fallback only
bun run build            # builds shared + server + plugin
bun test                 # runs the full test suite (pure-JS fallback)
```

To build the native module locally (your platform only):

```bash
cd packages/native
bun run build
```

This produces a `.node` file in the package directory. The umbrella `@the-40-thieves/obsidian-tc-native` loader picks it up automatically on the next test run.

## Working with the Codebase

### Starting the server in dev mode

```bash
cd packages/server
bun run dev              # auto-reload on file changes, dev auth mode, stdio transport
bun run dev:http         # same but binds HTTP on 127.0.0.1:8484
```

Point `OBSIDIAN_TC_VAULT_PATH` at a scratch vault. Do not use your real vault during development.

### Running the plugin in Obsidian

```bash
cd packages/plugin
bun run dev              # esbuild watch mode
```

Symlink `packages/plugin/dist/` into your test vault's `.obsidian/plugins/obsidian-tc/` directory. Enable the plugin in Obsidian Community Plugins. Restart Obsidian on manifest changes.

### Running the native module test suite

```bash
cd packages/native
cargo test --release     # Rust unit tests
bun run bench            # benchmarks (compares native vs fallback)
```

### Forcing fallback mode

To test the pure-JS fallback path without uninstalling the native module:

```bash
OBSIDIAN_TC_FORCE_FALLBACK=true bun test
```

CI runs both paths. Local development can use whichever is faster.

## Code Conventions

### Languages

- **TypeScript**: strict mode, no implicit any, no `any` without justification comment. Prettier and ESLint enforced.
- **Rust**: rustfmt and clippy clean. `#![deny(unsafe_code)]` outside the napi-rs FFI boundary.
- **Python**: ruff and pyright clean. Type hints required on all public functions.
- **YAML and Markdown**: prettier-formatted.

### Commits

Conventional Commits format, enforced via commitlint on PR open.

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.

Scopes match the package directory or a cross-cutting concern. Examples: `feat(server): add bulk_create_notes tool`, `fix(native): handle empty input to cosine`, `docs(architecture): clarify IPC contract`.

Breaking changes append `!` after the scope or include a `BREAKING CHANGE:` footer.

### Branches

Trunk-based with short-lived feature branches. Branch from `main`, name as `<type>/<short-description>` (e.g. `feat/bulk-notes-tool`). Rebase on `main` before opening PR, not after.

Release branches use `release/v{x.y.z}` for major and minor releases only. Patch releases ship directly from `main`.

### Pull Requests

Open PRs against `main`. Use the PR template. Required for merge:

1. All CI workflows green (`ci-server`, `ci-plugin`, `ci-native` × 5 platforms).
2. At least one review from a maintainer.
3. Conventional Commits format on the PR title (used to generate changelog).
4. Tests added for new behavior. Coverage may regress but should not regress meaningfully.
5. Documentation updated if the change is user-visible. README, `docs/`, or inline comments depending on scope.

PRs that miss required items will be flagged but not auto-closed. Maintainers help bring them across the line.

### Testing Expectations

- **Server**: unit tests live next to source as `*.test.ts`. Integration tests live in `packages/server/tests/`. Use Bun's built-in test runner.
- **Native**: Rust unit tests live in `#[cfg(test)]` modules. Integration tests live in `packages/native/tests/`. Benchmarks in `packages/native/benches/` use `criterion`.
- **Plugin**: unit tests via Bun test runner. End-to-end testing happens in Obsidian itself; document manual test steps in PRs that touch plugin behavior.
- **Pure-JS fallback parity**: any new Rust function must ship a TypeScript fallback that passes the same test suite. Performance budget: see `docs/G2.5-release-engineering.md` §4.

## Adding a New Tool

A typical tool addition touches four files:

1. `packages/shared/src/schemas/<domain>.ts` — Zod schema for input and output.
2. `packages/server/src/tools/<domain>/<tool_name>.ts` — implementation.
3. `packages/server/src/tools/<domain>/<tool_name>.test.ts` — tests.
4. `docs/src/content/docs/tools/<domain>/<tool_name>.md` — user-facing reference (or rely on the auto-generated path; see [`docs/contributing/how-to-add-a-tool.md`](./docs/src/content/docs/contributing/how-to-add-a-tool.md)).

Annotate the tool with ACL, HITL, idempotency, and rate-limit metadata per the G2.1 conventions. See `docs/G2.1-tools.md` for the full spec.

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

Releases are coordinated by maintainers. The full runbook lives at `docs/G2.5-release-engineering.md` §9. Briefly:

1. Bump version via `bunx bumpp`.
2. Update changelog via `bunx changelogen`.
3. Open release PR, get reviews, merge.
4. Tag the merge commit; `publish.yml` handles npm, GitHub Release, Docker.
5. Plugin store submission via PR to `obsidianmd/obsidian-releases` for new minor versions.

Contributors do not need to drive releases. Maintainers will tag when changes are ready.

## License

obsidian-tc is licensed under [Apache 2.0](./LICENSE). By submitting a contribution, you certify that you have the right to submit it under that license. See the [Developer Certificate of Origin](https://developercertificate.org/) for the formal statement of what we mean by this; signed-off commits are appreciated but not required.

## Getting Help

- GitHub Discussions for design questions, integration questions, "is this the right approach" questions.
- GitHub Issues for bug reports and feature requests.
- Discord (link in main README) for real-time discussion and pair-programming.

We aim to respond to discussions within a few days. For security issues, please follow [`SECURITY.md`](./SECURITY.md) for the disclosure timeline.
