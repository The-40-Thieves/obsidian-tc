---
title: Installation
description: Install the obsidian-tc MCP server via npm, a standalone binary, a one-click .mcpb bundle, or Docker.
---

The fastest way to try it, no install step and no config file:

```sh
npx obsidian-tc /path/to/vault
```

Every note tool and lexical search work immediately. Semantic search works out of the
box too: a bundled, fully offline embedder handles indexing with no config file, no
Ollama, and no API key (one-time model download on first use). The table below says
which install methods carry it; [Embeddings](/configuration/embeddings/) has the detail.
Ollama and every hosted provider (OpenAI, Voyage, Cohere, …) are opt-in either way — a
config file is what selects one, and is also the upgrade for ACLs, HITL, the generative
tier, and everything else — see [First Run](/getting-started/first-run/).

obsidian-tc ships in several forms. All of them run the same server; pick whichever
fits your environment.

| Method | macOS | Windows | Linux | Notes |
| --- | --- | --- | --- | --- |
| **npm** (Node 24+) | x64, arm64 | x64, arm64 | x64, arm64 | Universal; the recommended default. |
| **Standalone binary** | x64, arm64 | x64 | x64, arm64 | No runtime needed. On Windows-arm64, use npm. |
| **Docker** (GHCR) | via a Linux VM | via a Linux VM | amd64, arm64 | Container / server deployments. |
| **One-click `.mcpb`** | yes | yes | yes | For MCPB-capable hosts; runs under Node 24+, self-contained (built-in `node:sqlite`, no native dependency). |

### What works out of the box, per install method

Measured, not assumed: CI installs each path on a clean Ubuntu, macOS and Windows machine,
points it at a vault with no config file, and runs a real semantic search
(`ci-first-run-smoke`). Every cell passes on Ubuntu, on Apple Silicon macOS and on Windows. On Intel
macOS (`macos-15-intel`, `macos-26-intel`) ONNX Runtime publishes no native build, so npm, `.mcpb`,
and the standalone binary run the local embedder on ONNX Runtime's WASM backend instead, with the
same models. WASM embedding is roughly 4x slower than native in the measured two-text probe.

| Method | Default semantic search (no config) | Dense index (`sqlite-vec`) | Native addon | Size |
| --- | --- | --- | --- | --- |
| **npm** | Yes. The embedder installs with the server as an optional dependency. On Intel macOS it runs on the WASM backend. | Yes | Yes (prebuilds); pure-JS fallback elsewhere | Large install: the embedder's runtime is ~0.6 GB of `node_modules` |
| **Standalone binary** | Yes on Linux x64 and arm64, macOS arm64 and x64, and Windows x64: the embedder and its selected native/WASM ONNX runtime are inside the one file. | Yes (embedded) | Pure-JS fallback | About 14 MB larger than a binary without the embedder |
| **One-click `.mcpb`** | Yes on Linux x64 and arm64, macOS arm64 and x64, and Windows x64 | Yes | Pure-JS fallback (one universal bundle) | About 66 MB, up from about 2 MB; it carries all native runtimes plus the macOS x64 WASM assets |
| **Docker** | Not part of the matrix; see [Docker](#docker) below. | | | |

The model weights are not in any of them: the first search downloads and checksum-verifies
them (about 140 MB) into the cache directory, then works offline.

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

The bundled local embedder runs from inside the binary: it is compiled in with its selected ONNX
runtime, whose native files or macOS x64 WASM assets are unpacked into the cache directory
(`<cacheDir>/runtime/`) on first use, so semantic search works with no config file. That adds about
14 MB to the file. Intel macOS uses WASM, measured at roughly 4x slower embedding than native. The
local reranker cannot run from a binary, and the pure-JS fallback replaces the native addon;
lexical search is unaffected.

## Docker

```sh
docker run --rm -v "$HOME/vaults:/vaults" \
  -v "$HOME/.config/obsidian-tc:/config" \
  ghcr.io/the-40-thieves/obsidian-tc:1.33.1 /config/config.json
```

The image is an `oven/bun:1.4.2-slim` build (Debian, glibc): the native prebuilds are
gnu, so a glibc base keeps them loadable instead of forcing the pure-JS fallback. The
bundled local embedder (and local reranker) cannot resolve here either — the image
ships only the built server bundle, no `node_modules` — so the same npm-install
caveat above applies: set a hosted or self-hosted `embeddings.provider` for semantic
search until the embedder package's first npm publish lands.

## One-click bundle (`.mcpb`)

For MCPB-capable MCP hosts, each release attaches a one-click `obsidian-tc.mcpb`
bundle. It runs the server under the host's Node (24+) and is self-contained: no
`node_modules` and no native build are required on the machine. It carries `sqlite-vec`
for every platform (loaded through Node's built-in `node:sqlite`, so the dense index is on)
and the bundled local embedder with native ONNX Runtime for Linux x64 and arm64, macOS arm64 and
Windows x64, plus ONNX Runtime Web WASM for macOS x64. Semantic search therefore works with no
config file on every current target. Because one bundle serves every OS, it uses the pure-JS
fallback instead of the native addon, and it is about 66 MB.
Install it through your host's MCP-bundle installer.

Anthropic's connector directory no longer accepts local servers packaged as `.mcpb`
(its [submission guide](https://claude.com/docs/connectors/building/submission), read
2026-10-10, sends local servers through a plugin). The bundle still installs by hand in
Claude Desktop and other MCPB hosts; the plugin below is the route for Claude's directory.

## Claude Code plugin and other agents

The repository is also a Claude-style plugin marketplace. The plugin launches the
published package over stdio (`npx -y obsidian-tc`) and asks for your config file path
when you enable it, passing it to the server as `OBSIDIAN_TC_CONFIG`.

```sh
claude plugin marketplace add The-40-Thieves/obsidian-tc
claude plugin install obsidian-tc@the-40-thieves
```

Inside a session the same thing is `/plugin marketplace add The-40-Thieves/obsidian-tc`.
Node 24+ must be on `PATH` for `npx`.

- **Grok Build** documents that it reads Claude Code marketplaces, plugins and MCP servers
  with no extra setup ([docs.x.ai](https://docs.x.ai/build/features/skills-plugins-marketplaces),
  read 2026-10-10). Its docs do not say which files it reads, and the `${user_config.*}`
  substitution is a Claude Code feature, so if the server starts with a literal
  placeholder as its config path, set `OBSIDIAN_TC_CONFIG` yourself in a `.grok` MCP entry.
- **Muse Code** (1.4.0 and later) has a plugin system that third-party write-ups report sits
  behind `MUSE_EXPERIMENTAL_PLUGINS=1`. It reads the same marketplace file, and the plugin carries a `.muse-plugin/plugin.json`
  with the server under `capabilities.mcpServers`. Meta's published Muse Code docs do not yet
  describe the plugin format, so that manifest follows the shape existing Muse plugins use and
  has not been run through `muse plugins validate` here. Export `OBSIDIAN_TC_CONFIG` in the
  shell that starts Muse; the manifest has no place to prompt for it.

One-click install into an editor (generated from the same launch config as the plugin, and
checked in CI):

<!-- BEGIN INSTALL-LINKS (generated by scripts/gen-install-links.mjs; do not hand-edit) -->
[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](cursor://anysphere.cursor-deeplink/mcp/install?name=obsidian-tc&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm9ic2lkaWFuLXRjIl0sImVudiI6eyJPQlNJRElBTl9UQ19DT05GSUciOiIvQUJTT0xVVEUvUEFUSC9UTy9vYnNpZGlhbi10Yy5jb25maWcuanNvbiJ9fQ%3D%3D)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_obsidian--tc-0098FF?logo=visualstudiocode&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22obsidian-tc%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22obsidian-tc%22%5D%2C%22env%22%3A%7B%22OBSIDIAN_TC_CONFIG%22%3A%22%2FABSOLUTE%2FPATH%2FTO%2Fobsidian-tc.config.json%22%7D%7D)
[Install in VS Code Insiders](vscode-insiders:mcp/install?%7B%22name%22%3A%22obsidian-tc%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22obsidian-tc%22%5D%2C%22env%22%3A%7B%22OBSIDIAN_TC_CONFIG%22%3A%22%2FABSOLUTE%2FPATH%2FTO%2Fobsidian-tc.config.json%22%7D%7D)
<!-- END INSTALL-LINKS -->

Replace the placeholder path with your config file after installing.

### claude.ai and Claude Desktop (remote HTTP)

claude.ai has no install deep link. For a server you host over Streamable HTTP, add it as a
custom connector: **Customize > Connectors > + Add > Add custom connector**, enter the name and
the server's `https://` MCP URL (for example `https://your-host/mcp`), then set the
authentication the server uses (see [Auth](/security/auth-model/)). Team and Enterprise
owners add it under Organization settings > Connectors. Source:
[Anthropic's custom connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp),
read 2026-10-10.

Use the `/mcp/core` URL where a client or directory wants a flat tool list with no
generic executor; every tool on it states `readOnlyHint`, `destructiveHint` and
`openWorldHint` explicitly.

## Companion plugin

Tools that bridge into a live Obsidian instance (Dataview, Templater, OCR, command
execution) require the companion plugin, **TC Bridge**, which exposes the vault's
Local REST API. Install it from Obsidian's Community Plugins browser (search
"TC Bridge", or go directly to
[community.obsidian.md/plugins/tc-bridge](https://community.obsidian.md/plugins/tc-bridge))
and enable it. The release's plugin zip, extracted into `.obsidian/plugins/`, is
the manual fallback for hosts that can't reach the community directory. The
server runs without it either way — those bridge tools simply degrade to
`plugin_missing`.

Next: [First Run](/getting-started/first-run/).
