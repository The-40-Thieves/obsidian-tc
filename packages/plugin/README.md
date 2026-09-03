# @the-40-thieves/obsidian-tc-plugin

Companion Obsidian plugin for the obsidian-tc MCP server, shipped under the manifest id
`tc-bridge` / name "TC Bridge" (renamed from `obsidian-tc` / "Obsidian Turbocharged", THE-943 —
see "Renamed to TC Bridge" below; the npm package name above is unaffected).

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

## Renamed to TC Bridge (THE-943)

Obsidian's community-directory rules ban the word "obsidian" in a plugin id (verified via
context7 against `obsidianmd/obsidian-developer-docs`, 2026-09-03), so this plugin's Obsidian
manifest changed from id `obsidian-tc` / name "Obsidian Turbocharged" to id `tc-bridge` / name
"TC Bridge". The npm package name (`@the-40-thieves/obsidian-tc-plugin`, this file's own header)
and the MCP server's own name (`obsidian-tc`) are unaffected — only the Obsidian-facing manifest
`id`/`name`/`description` changed.

- **Settings migration**: on first load, if `<vault>/.obsidian/plugins/obsidian-tc/data.json`
  exists and `<vault>/.obsidian/plugins/tc-bridge/data.json` does not yet, TC Bridge copies it
  over and shows one notice. Existing users keep their LRA key / config across the rename.
- **Conflict guard**: if the old `obsidian-tc` plugin is still *enabled* when TC Bridge loads, TC
  Bridge refuses to start and shows a notice naming the conflict — running both together would
  register the same bridge routes on Local REST API twice. Disable `obsidian-tc` first.
- **Old-id sunset build**: `packages/plugin/legacy/` builds one final `obsidian-tc` release (id
  and name unchanged, manifest version bumped once) that does nothing but show a notice pointing
  installed users at TC Bridge. It is built by the release job (`.github/workflows/publish.yml`,
  `build-plugin`) as a separate artifact and never updates again.
- Manual-install path for existing users: BRAT users repoint their tracked repo entry at the same
  repository (the manifest `id` BRAT reads changed, not the repo); direct/zip installs replace
  the plugin folder contents with the `tc-bridge` release assets and rename the folder itself
  from `obsidian-tc` to `tc-bridge` — Obsidian requires the folder name to match `manifest.id`.
  See `docs/superpowers/plans/2026-09-03-listings/community-obsidian.md` for the prepared (not
  yet submitted) community-directory listing text.

## Community-store submission notes (THE-282)

- `versions.json` (version → `minAppVersion`) lives beside `manifest.json` in this package and is
  asserted by `scripts/check-version-coherence.mjs`. **Obsidian's release tooling reads
  `manifest.json`/`versions.json` from the plugin repository ROOT** — a store submission requires
  either a dedicated plugin repo or copying both files to the monorepo root at release time.
- `isDesktopOnly: true`: TC Bridge bridges to a locally-running MCP server via the Local REST API
  plugin, which has no mobile-Obsidian equivalent for that local access — the same convention
  comparable bridge plugins use (verified 2026-09-03). It opens no port of its own; on platforms
  without LRA it simply never registers routes and degrades cleanly.

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
