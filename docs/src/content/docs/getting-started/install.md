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
(`ci-first-run-smoke`). All nine cells pass.

| Method | Default semantic search (no config) | Dense index (`sqlite-vec`) | Native addon | Size |
| --- | --- | --- | --- | --- |
| **npm** | Yes. The embedder installs with the server as an optional dependency. | Yes | Yes (prebuilds); pure-JS fallback elsewhere | Large install: the embedder's runtime is ~0.6 GB of `node_modules` |
| **Standalone binary** | Yes on Linux x64 and arm64, macOS arm64 and Windows x64: the embedder and its ONNX runtime are inside the one file. **No on macOS x64** (the runtime has no build for it; configure a hosted provider). | Yes (embedded) | Pure-JS fallback | About 14 MB larger than a binary without the embedder |
| **One-click `.mcpb`** | Yes on Linux x64 and arm64, macOS arm64 and Windows x64 | Yes | Pure-JS fallback (one universal bundle) | About 52 MB, up from about 2 MB; it carries the ONNX runtime for Linux x64 and arm64, macOS arm64 and Windows x64 |
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

The bundled local embedder runs from inside the binary: it is compiled in with its ONNX
runtime, whose native files are unpacked into the cache directory (`<cacheDir>/runtime/`)
on first use, so semantic search works with no config file. That adds about 14 MB to the
file. It is not available in the macOS x64 binary (the ONNX runtime ships no macOS x64
build); set `embeddings.provider` to a hosted or self-hosted backend there (see
[Embeddings](/configuration/embeddings/)). The local reranker cannot run from a binary
either way, and the pure-JS fallback replaces the native addon; lexical search is
unaffected.

## Docker

```sh
docker run --rm -v "$HOME/vaults:/vaults" \
  -v "$HOME/.config/obsidian-tc:/config" \
  ghcr.io/the-40-thieves/obsidian-tc:1.32.0 /config/config.json
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
and the bundled local embedder with its ONNX runtime for Linux x64 and arm64, macOS arm64
and Windows x64, so semantic search works with no config file. Because one bundle serves
every OS, it uses the pure-JS fallback instead of the native addon, and it is about 52 MB.
On an OS outside that list, configure a hosted or self-hosted `embeddings.provider`.
Install it through your host's MCP-bundle installer.

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
