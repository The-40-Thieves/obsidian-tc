---
title: Installation
description: Install the obsidian-tc MCP server via npm, a standalone binary, or Docker.
---

obsidian-tc ships in several forms. All of them run the same server; pick whichever
fits your environment.

| Method | macOS | Windows | Linux | Notes |
| --- | --- | --- | --- | --- |
| **npm** (Node 24+) | x64, arm64 | x64, arm64 | x64, arm64 | Universal; the recommended default. |
| **Standalone binary** | x64, arm64 | x64 | x64, arm64 | No runtime needed. On Windows-arm64, use npm. |
| **Docker** (GHCR) | via a Linux VM | via a Linux VM | amd64, arm64 | Container / server deployments. |
| **One-click `.mcpb`** | yes | yes | yes | For MCPB-capable hosts; runs under Node 24+, self-contained (built-in `node:sqlite`, no native dependency). |

## npm (Node 24+)

```sh
npm install -g obsidian-tc
obsidian-tc --version
```

This installs the `obsidian-tc` binary backed by the published `obsidian-tc`
package and its `@the-40-thieves/obsidian-tc-{shared,native}` companions. The
native module ships prebuilds for eight targets — `linux-x64-gnu`,
`linux-arm64-gnu`, `linux-x64-musl`, `linux-arm64-musl` (Alpine), `darwin-x64`,
`darwin-arm64`, `win32-x64-msvc`, and `win32-arm64-msvc`; on any other platform it
transparently falls back to a pure-JS implementation.

## Standalone binary

Each release attaches self-contained executables (built with `bun build --compile`,
bytecode + minified) that bundle the runtime, so no Node or Bun is required on the
host. Targets: macOS x64 + arm64, Windows x64, and Linux x64 + arm64. Download the
asset for your platform from the GitHub release and run it directly. (Windows on
arm64 is not a `bun --compile` target; use the npm install there.)

## Docker

```sh
docker run --rm -v "$HOME/vaults:/vaults" \
  -v "$HOME/.config/obsidian-tc:/config" \
  ghcr.io/the-40-thieves/obsidian-tc:1.10.0 /config/config.json
```

The image is an `oven/bun:1-slim` build (Debian, glibc): the native prebuilds are
gnu, so a glibc base keeps them loadable instead of forcing the pure-JS fallback.

## One-click bundle (`.mcpb`)

For MCPB-capable MCP hosts, each release attaches a one-click `obsidian-tc.mcpb`
bundle. It runs the server under the host's Node (24+) and is fully self-contained:
no `node_modules` and no native build are required, because it uses Node's built-in
`node:sqlite` when `better-sqlite3` is absent (vector search then uses the
brute-force fallback). Install it through your host's MCP-bundle installer.

## Companion plugin

Tools that bridge into a live Obsidian instance (Dataview, Templater, OCR, command
execution) require the companion plugin, which exposes the vault's Local REST API.
Install it from the release's plugin zip into `.obsidian/plugins/`. The server runs
without it — those bridge tools simply degrade to `plugin_missing`.

Next: [First Run](/getting-started/first-run/).
