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
# obsidian-tc 1.3.6 ready on stdio (vault primary)
```

By default the server speaks the Model Context Protocol over **stdio**, the
trusted local transport: the operator runs the binary against their own vault, so
calls are authenticated with full local scope.

## 3. Connect a client

Point any MCP client (Claude Desktop, an IDE extension, or your own agent) at the
command. For Claude Desktop, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "obsidian-tc": {
      "command": "obsidian-tc",
      "args": ["/home/user/.config/obsidian-tc/config.json"]
    }
  }
}
```

By default `tools/list` advertises the **triad** facade: three meta-tools
(`find_capability`, `describe_capability`, `call_capability`) for progressive
discovery, with every underlying tool still callable by name. Set
`toolFacade.mode: "flat"` to advertise the full surface, or `"domain"` for
~a dozen domain meta-tools. To serve over HTTP for remote agents, enable the HTTP
transport and JWT auth — see [Authentication](/security/auth-model/) and
[Configuration](/configuration/config-yaml/).
