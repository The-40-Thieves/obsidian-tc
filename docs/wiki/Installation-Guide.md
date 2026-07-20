<!-- TEMPLATE / BLUEPRINT — Installation Guide. Fill the < … > placeholders. -->

# Installation Guide

Get an obsidian-tc server indexing your vault and answering agent queries.

> [!IMPORTANT]
> obsidian-tc is a **server**, not a plugin. You run it once, it builds an index, and agents connect to it over MCP. It does **not** require Obsidian to be open.

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Runtime | < Bun x.y / Node ≥ 24 > | < which is recommended > |
| Embedding provider | Ollama / OpenAI / < … > | reachable at index + query time |
| Disk | < ~N MB per 1k notes > | for the SQLite cache + vectors |

## 1. Install

```bash
# < package / clone / docker — pick your distribution >
git clone https://github.com/The-40-Thieves/obsidian-tc.git
cd obsidian-tc
< build/install command >
```

## 2. Configure

Create a config file pointing at your vault and embedding provider:

```jsonc
{
  "vaults": [{ "id": "main", "path": "/path/to/Obsidian Vault" }],
  "embeddings": { "provider": "< ollama|openai|… >", "model": "< model >" }
  // full reference: see the Configuration Reference page
}
```

> [!TIP]
> Every configuration key, its type, and its default are documented on the **[Configuration Reference](Configuration-Reference)** page (generated from the schema, so it never drifts).

## 3. Build the first index

```bash
< command to run index_vault / initial reconcile >
```

> [!NOTE]
> The first index embeds every chunk and can take a while on a large vault; subsequent runs are near-instant (content-hash skipping). Watch progress on the **[Observability](Observability)** dashboard or via `server_health`.

## 4. Connect an agent

Point your MCP client at the server:

```jsonc
// stdio
{ "command": "< binary >", "args": ["serve", "--config", "config.json"] }
```

For remote / HTTP, see **[Deployment & Operations](Deployment-and-Operations)**.

> [!WARNING]
> The HTTP transport fail-closes on a non-loopback bind under `auth.mode: "none"`. Before exposing it, configure JWT auth and read **[Security & ACLs](Security-and-ACLs)**.

## Verify

```bash
# Ask the server for its health + index status
< example server_health call >
```

You should see `reconcile: "ok"`, `notes_ready: true`, and `vec_enabled: true`.

## Next steps

- [Tool Reference](Tool-Reference) — what agents can now do
- [Reading & Writing Notes](Reading-and-Writing-Notes) — the write surface
- [Troubleshooting](Troubleshooting) — if something's off
