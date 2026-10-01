# AGENTS.md

Instructions for AI coding agents working in this repository.

## Agent skills

### Issue tracker

Issues live in Linear on the **The 13th Letter** team (`THE-` prefix), accessed via the Linear MCP
server; pull requests live on GitHub and are a delivery surface, not a request surface. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name — `needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` and one `docs/adr/` at the repo root, covering all four
workspaces. See `docs/agents/domain.md`.

## Cloud agent environment setup

Cloud agent VMs (Google Jules, Codex cloud and similar) do not preinstall Bun. Install the pinned
version first; the pin lives in `mise.toml` and `packageManager` in `package.json`, which must
agree (currently `1.4.2`):

```bash
export BUN_INSTALL="$HOME/.bun"   # some VMs can't write the installer's default location
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2"
export PATH="$BUN_INSTALL/bin:$PATH"
bun --version   # must print 1.4.2
bun install --frozen-lockfile
```

Run these before proposing a change:

```bash
bun run lint        # biome only
bun run typecheck   # all four packages plus the bun-smoke project
cd packages/server && bunx vitest run test/<touched-area>.test.ts   # targeted tests, not the full suite
```

The Rust toolchain and the native addon are needed only when a change touches `packages/native`; the
server falls back to JavaScript implementations without the addon. Build it with `bun run build` in
that package. The Rust version is pinned in `packages/native/rust-toolchain.toml`.
