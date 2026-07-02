---
title: Installation
description: Install the obsidian-tc MCP server via npm, a standalone binary, or Docker.
---

obsidian-tc ships in three forms. All of them run the same server; pick whichever
fits your environment.

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
bytecode + minified) that bundle the runtime — no Node or Bun required on the host.
Download the asset for your platform from the GitHub release and run it directly.

## Docker

```sh
docker run --rm -v "$HOME/vaults:/vaults" \
  -v "$HOME/.config/obsidian-tc:/config" \
  ghcr.io/the-40-thieves/obsidian-tc:1.2.1 /config/config.json
```

The image is an `oven/bun:1-slim` build (Debian, glibc): the native prebuilds are
gnu, so a glibc base keeps them loadable instead of forcing the pure-JS fallback.

## Companion plugin

Tools that bridge into a live Obsidian instance (Dataview, Templater, OCR, command
execution) require the companion plugin, which exposes the vault's Local REST API.
Install it from the release's plugin zip into `.obsidian/plugins/`. The server runs
without it — those bridge tools simply degrade to `plugin_missing`.

Next: [First Run](/getting-started/first-run/).
