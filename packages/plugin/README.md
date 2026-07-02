# @the-40-thieves/obsidian-tc-plugin

Companion Obsidian plugin for the obsidian-tc MCP server.

Extends the Local REST API plugin with namespaced endpoints for:

- Command palette dispatch
- Templater execution
- Dataview DQL queries
- Tasks plugin queries
- OCR via Text Extractor
- QuickAdd triggers
- Smart Connections embeddings
- Smart Context bundling
- Workspaces and Bookmarks state

The server can operate without this plugin (degraded mode — filesystem-only operations). Install the plugin for the full feature surface.

See the [repo root README](../../README.md) for project overview.

## Security / trust boundary

This plugin extends the Local REST API (LRA) plugin's HTTP server and reuses its bearer-token auth.
**Possession of the LRA API key is equivalent to full vault admin** — LRA's own endpoints already
grant full read / write / delete, so the companion routes run with the same authority and do not add
a second gate. Treat the LRA key like a root password for the vault; do not share it with partially
trusted clients or embed it in agent-visible config. The server-side ACL / HITL / scope gates
protect the **MCP surface**, not direct LRA / companion HTTP calls. See
[SECURITY.md](../../SECURITY.md#companion-plugin-trust-boundary) for the full trust model.
