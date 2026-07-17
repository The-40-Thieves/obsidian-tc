---
title: First Run
description: Write a minimal config, start the server, and connect an MCP client.
---

## 1. Write a config

obsidian-tc is launched with a path to a **JSON** config file. A minimal
single-vault config:

```json
{
  "vaults": [{ "id": "primary", "path": "/home/user/vaults/primary" }],
  "cacheDir": "/home/user/.cache/obsidian-tc",
  "auth": { "mode": "none" }
}
```

## 2. Start it

```sh
obsidian-tc ./config.json
# obsidian-tc 1.10.0 ready on stdio (vault primary)
```

By default the server speaks the Model Context Protocol over **stdio**, the
trusted local transport: the operator runs the binary against their own vault, so
calls are authenticated with full local scope.

## 3. Connect a client

Point any MCP client at the command. The config path can be an argument or the
`OBSIDIAN_TC_CONFIG` env var — the env form keeps client entries uniform.

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "obsidian-tc": {
      "command": "npx",
      "args": ["-y", "obsidian-tc"],
      "env": { "OBSIDIAN_TC_CONFIG": "/ABSOLUTE/PATH/TO/config.json" }
    }
  }
}
```

(A globally-installed binary works too: `"command": "obsidian-tc", "args": ["/path/config.json"]`.)

**Claude Code** — one command:

```sh
claude mcp add obsidian-tc --env OBSIDIAN_TC_CONFIG=/ABSOLUTE/PATH/TO/config.json -- npx -y obsidian-tc
```

**Cursor** (`~/.cursor/mcp.json`) and **VS Code** (`.vscode/mcp.json`) use the same
server object — only the wrapper key differs (`mcpServers` vs `servers`). The
repository README has one-click install badges for both.

Optional env vars worth knowing at wiring time: `OBSIDIAN_TC_GATEWAY_URL` turns on
the generative tier ([inference gateway](/configuration/inference-gateway/));
`OBSIDIAN_TC_DEFAULT_VAULT` picks the default when several vaults are configured.
The complete list is in the [configuration reference](/configuration/config-yaml/).

By default `tools/list` advertises the **triad** facade: three meta-tools
(`find_capability`, `describe_capability`, `call_capability`) for progressive
discovery, with every underlying tool still callable by name. Set
`toolFacade.mode: "flat"` to advertise the full surface, or `"domain"` for
~a dozen domain meta-tools. To serve over HTTP for remote agents, enable the HTTP
transport and JWT auth — see [Authentication](/security/auth-model/) and
[Configuration](/configuration/config-yaml/).

## 4. Optional power-ups

- **Live plugin bridges** (Dataview, Templater, Git, OCR, …): give the vault entry
  `restApiUrl` + `restApiKey` and install the companion plugin — the walkthrough is
  [QUICKSTART step 6](https://github.com/The-40-Thieves/obsidian-tc/blob/main/docs/QUICKSTART.md).
- **The generative tier** (`reflect` synthesis, decision red-teaming, sleep-time
  consolidation): set `OBSIDIAN_TC_GATEWAY_URL` — see
  [Inference gateway](/configuration/inference-gateway/).
- **Every other option** — ACLs, throttles, snapshots, observability exporters,
  tool-surface shaping: the [complete configuration reference](/configuration/config-yaml/).
