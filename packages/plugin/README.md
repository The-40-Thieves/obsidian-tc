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

## Write coherence with a live Obsidian

The server writes direct-to-disk; see [docs/COHERENCE.md](../../docs/COHERENCE.md) for the
sole-agent-writer contract, open-pane refresh caveats, and Windows rename semantics.

## Community-store submission notes (THE-282)

- `versions.json` (version → `minAppVersion`) lives beside `manifest.json` in this package and is
  asserted by `scripts/check-version-coherence.mjs`. **Obsidian's release tooling reads
  `manifest.json`/`versions.json` from the plugin repository ROOT** — a store submission requires
  either a dedicated plugin repo or copying both files to the monorepo root at release time.
- `isDesktopOnly: false` is deliberate: the plugin opens no port of its own (it rides the Local
  REST API plugin's server); on platforms without LRA it simply never registers routes and
  degrades cleanly.

## Private-API reliance (reviewer inventory)

The bridges deliberately duck-type Obsidian internals that have no public API; every use degrades
to a typed error (never a crash) when the shape moves, and the startup self-check surfaces drift
on `/probe` (`shape_ok` / `shape_warnings`):

| Internal | Used for |
|---|---|
| `app.commands.listCommands()` / `executeCommandById()` | command-palette dispatch |
| `app.plugins.plugins[id]` (+ per-plugin `.api` / `.settings`) | capability probe + plugin bridges |
| Local REST API's `requestHandler.apiExtensionRouter` / `api.addRoute` | route registration |
| Templater's `create_new_note_from_template` | `execute_template` |
