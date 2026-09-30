# obsidian-tc

![obsidian-tc quickstart demo](docs/public/demo/quickstart-storyboard.svg)

> Obsidian Turbocharged — governed, agent-ready vault access over MCP.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
![Status: Shipped v1.31.8](https://img.shields.io/badge/Status-Shipped_v1.31.8-success)

## What it is

obsidian-tc is a governed, agent-ready [Model Context Protocol](https://modelcontextprotocol.io)
server for [Obsidian](https://obsidian.md) vaults, for humans and agents alike. Instead of raw
filesystem access to years of notes, every tool call runs through one pipeline — auth, folder
ACLs, a read-only kill switch, HITL confirmation on destructive ops, and an audit log. It also
adds fused retrieval (full-text, vector, graph) and a memory tier — episodes, decay, forgetting —
living *inside* your vault under that same ACL.
**A full tool surface across every domain** (all visible by default; a smaller set with opt-in
`profile: "core"`), via a 3-tool facade, listed in the
[tool catalog](https://obsidian-tc.the40thieves.io/tools/tool-catalog/). Pitch: [docs/WHY.md](./docs/WHY.md).

## 60-second start

No install:

```sh
npx obsidian-tc /path/to/vault
```

Every note tool and lexical search work immediately. Semantic search defaults to a bundled
embedder — see [When NOT to use](#when-not-to-use-obsidian-tc) below for which install methods it
reaches today.

For multi-vault, auth, or ACLs, use a config file:

```bash
npm install -g obsidian-tc
obsidian-tc ./obsidian-tc.config.json   # Node >= 24 or Bun >= 1.1
```

Also ships as a Docker image, `.mcpb` bundle, and standalone binaries. More:
[docs/QUICKSTART.md](./docs/QUICKSTART.md).

## When NOT to use obsidian-tc

Honest guidance — this is a heavier product than most:

- **Smallest possible footprint, read-only access, or no MCP at all.** A single trusted human
  over one vault, a read-only wrapper, or the Obsidian URI/Local REST API plugin directly may be
  all you need — see the [full comparison](https://obsidian-tc.the40thieves.io/getting-started/compare/).
- **Zero setup, source checkouts only for now.** The vault is read directly off disk; semantic
  search defaults to a bundled offline embedder; npm/Docker need an explicit provider until
  published — see [Embeddings](https://obsidian-tc.the40thieves.io/configuration/embeddings/).
- **Zero-config trades away auth/ACLs.** `obsidian-tc /path/to/vault` boots with auth off, no
  folder ACL — fine only because it's local-only; governance is opt-in. Detail: [SECURITY.md](./SECURITY.md).
- **AGPL-3.0's network-copyleft terms.** Not permissive; a commercial license may exist — see
  [License](#license).
- **Single-maintainer project.**
- **Everything inside Obsidian, or vault-independent memory.** See the
  [comparison](https://obsidian-tc.the40thieves.io/getting-started/compare/) above.

Migrating from another MCP server: [docs/CUTOVER.md](./docs/CUTOVER.md).

## How it compares

Most Obsidian MCP projects are vault-access servers, retrieval engines, or memory engines, rarely
more than one. obsidian-tc is the only one we know of that is all three, with memory living **in
the vault** under the same ACL as every other write. [Full 9-project table and "where the others
win"](https://obsidian-tc.the40thieves.io/getting-started/compare/).

| | Tools | Group | What it's for |
|---|---|---|---|
| **obsidian-tc** | full surface (3-tool facade) | all three | governed access + retrieval + in-vault memory |
| [obsidian-local-rest-api](https://github.com/coddingtonbear/obsidian-local-rest-api) | 18 | access | Obsidian's own built-in MCP server; one bearer key, no ACL |
| [basic-memory](https://github.com/basicmachines-co/basic-memory) | ~35 | memory | entities/relations in a separate, portable markdown KB |

---

## More

<details><summary>Table of contents</summary>

[TC Bridge](#tc-bridge-the-companion-obsidian-plugin) ·
[Status](#status) ·
[Architecture](#architecture) ·
[The interface](#the-interface-3-tools-every-governed-capability) ·
[Cursor / VS Code](#install-in-cursor--vs-code) ·
[Docs](#docs) ·
[Trademark](#trademark) ·
[License](#license) ·
[Contributing](#contributing)

</details>

### TC Bridge: the companion Obsidian plugin

If you arrived here from Obsidian's plugin browser: the **TC Bridge** listing points here because
the plugin lives in this repo, but it's a small optional bridge, not the server described above. It
extends [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) with endpoints
for Obsidian-only features (Templater, Dataview, Tasks, Excalidraw, Git, Remotely Save). Every
filesystem-level feature works without it.

- **Install Local REST API first**; TC Bridge reuses its bearer-token auth, desktop-only. The
  plugin is not the server — governance/retrieval run in the obsidian-tc process, installed
  separately ([60-second start](#60-second-start)); reaching the bridges needs
  `restApiUrl`/`restApiKey` in the vault config
  ([step 6](./docs/QUICKSTART.md#6-optional-light-up-the-plugin-bridges-live-mode)). That key is a
  vault root password — read the [trust boundary](./SECURITY.md#companion-plugin-trust-boundary) first.
- **Formerly "Obsidian Turbocharged."** Settings migrate on first load — details in
  [packages/plugin/README.md](./packages/plugin/README.md).

### Status

**Shipped — v1.31.8**, published to npm as provenance-signed packages, container image on GHCR.
Milestones: [Roadmap](https://obsidian-tc.the40thieves.io/roadmap/); releases:
[CHANGELOG.md](./CHANGELOG.md).

Retrieval changes are measured, not asserted: a statistical ship rule gates every ranking change
against a private golden set. Headline figures once on this README were withdrawn 2026-08-07 as
unreproducible — full account and a public-corpus result since:
[docs/EVALUATION.md](./docs/EVALUATION.md).

### Architecture

Polyglot monorepo:

| Package | Language | Purpose |
|---|---|---|
| `packages/server` | TypeScript (Bun) | MCP layer, auth, routing, tools, plugin bridges |
| `packages/plugin` | TypeScript | Companion Obsidian plugin extending Local REST API |
| `packages/shared` | TypeScript | Shared Zod schemas and types |
| `packages/native` | Rust (napi-rs) | Optional acceleration, pure-JS fallback |

Dispatch-pipeline and package-layout detail: [ARCHITECTURE.md](./ARCHITECTURE.md).

Every capability is a governed tool with declared access scopes. **Read** tools (`read_note`,
`search_vault`, `get_backlinks`, ...) never mutate the vault. **Write** tools cover whole-note and
partial edits: `write_note`, `append_note`, `patch_note` (heading- and block-anchored edits),
`update_frontmatter`, tag and link maintenance. Separate scope classes gate **delete** and move
(`delete_note`, `move_note`), **bulk** operations (`bulk_set_property`), **execute** (`execute_command`)
and **admin** (`add_vault`, `reload_vault`). The complete, always-current list, grouped by access
scope and generated from the tool registry, is the
[tool catalog](https://obsidian-tc.the40thieves.io/tools/tool-catalog/).

### The interface: 3 tools, every governed capability

By default the server advertises just **three meta-tools** instead of a wall of 164:
`find_capability`, `describe_capability`, `call_capability` (invoke by name, same pipeline as a
direct call). `toolFacade.mode` selects `triad` (default), `domain`, `flat`, or `auto` — boundary-
only, no gate bypassed.

### Install in Cursor / VS Code

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](cursor://anysphere.cursor-deeplink/mcp/install?name=obsidian-tc&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm9ic2lkaWFuLXRjIl0sImVudiI6eyJPQlNJRElBTl9UQ19DT05GSUciOiIvQUJTT0xVVEUvUEFUSC9UTy9vYnNpZGlhbi10Yy5jb25maWcuanNvbiJ9fQ==)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_obsidian--tc-0098FF?logo=visualstudiocode&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22obsidian-tc%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22obsidian-tc%22%5D%2C%22env%22%3A%7B%22OBSIDIAN_TC_CONFIG%22%3A%22%2FABSOLUTE%2FPATH%2FTO%2Fobsidian-tc.config.json%22%7D%7D)

Or by hand — Cursor (`mcpServers`) / VS Code (`servers`), same object:
`{"command": "npx", "args": ["-y", "obsidian-tc"], "env": {"OBSIDIAN_TC_CONFIG": "/ABS/config.json"}}`.
A `.mcpb` bundle (`bun run bundle`) also installs into Claude Desktop / other MCPB hosts.

### Docs

- [docs/QUICKSTART.md](./docs/QUICKSTART.md) — install to first governed write, ~5 min
- [docs/WHY.md](./docs/WHY.md) / [SECURITY.md](./SECURITY.md) — threat model, governance
- [docs/CUTOVER.md](./docs/CUTOVER.md) — migrating from another Obsidian MCP server
- [docs/EVALUATION.md](./docs/EVALUATION.md) — how retrieval changes are measured
- [ARCHITECTURE.md](./ARCHITECTURE.md) — dispatch pipeline, package layout
- Docs site: <https://obsidian-tc.the40thieves.io> (full comparison under Getting Started)

### Trademark

obsidian-tc is independent and community-built, **not** affiliated with or endorsed by Obsidian
or its maker, Dynalist Inc. "Obsidian" is a Dynalist Inc. trademark, used only nominatively.
Official app: [obsidian.md](https://obsidian.md).

### License

AGPL-3.0-only. See [LICENSE](./LICENSE) and the
[licensing FAQ](https://obsidian-tc.the40thieves.io/licensing/); a commercial exception may
exist — open a [discussion](https://github.com/The-40-Thieves/obsidian-tc/discussions).
Contributions under the [DCO](https://developercertificate.org/); sign-off in
[CONTRIBUTING.md](./CONTRIBUTING.md#license-and-sign-off-dco).

### Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) / [Code of Conduct](./CODE_OF_CONDUCT.md).
Security: [SECURITY.md](./SECURITY.md).
