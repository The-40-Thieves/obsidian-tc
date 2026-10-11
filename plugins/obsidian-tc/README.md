# obsidian-tc plugin

Governed, agent-ready access to an [Obsidian](https://obsidian.md) vault over MCP: every tool call
runs through authentication, folder ACLs, a read-only kill switch, HITL confirmation on destructive
operations and an audit log, with hybrid retrieval and an in-vault memory tier on top. Full
description: [obsidian-tc](https://github.com/The-40-Thieves/obsidian-tc#readme).

## What this plugin runs

It starts one MCP server over stdio, pinned to the version of this plugin:

```sh
npx -y obsidian-tc@<plugin version>
```

That downloads the published [`obsidian-tc`](https://www.npmjs.com/package/obsidian-tc) npm package
(AGPL-3.0-only, provenance-signed) and runs it on your machine under Node 24 or later. The server
reads the vault folders named in your config file and writes only inside them, subject to the
config's ACL. It sends nothing off your machine except what you configure yourself (for example a
hosted embeddings provider). Nothing is bundled in this plugin besides the manifests.

## Install

```sh
claude plugin marketplace add The-40-Thieves/obsidian-tc
claude plugin install obsidian-tc@the-40-thieves
```

Claude Code asks for the absolute path of your obsidian-tc JSON config when you enable the plugin,
and passes it to the server as `OBSIDIAN_TC_CONFIG`. To create one, follow
[First Run](https://obsidian-tc.the40thieves.io/getting-started/first-run/).

## Privacy

The server runs locally and keeps its index in your vault's cache directory. See
[SECURITY.md](https://github.com/The-40-Thieves/obsidian-tc/blob/main/SECURITY.md) for the threat
model and the data each optional integration can send.
