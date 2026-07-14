# CUTOVER: obsidian-tc as the sole Obsidian agent interface (THE-279)

This document is the cutover plan that makes **obsidian-tc** the only MCP surface an
agent uses against Obsidian vaults. It retires:

- the **obsidian-local-rest-api MCP surface** (LRA 4.1.3 "with-MCP") as an agent interface,
- **obsidian-mcp-tools 0.2.33**, and
- the **obsidian-headless / CLI-wrapper** MCP entries.

The Local REST API plugin itself is **not** retired: it stays installed and enabled as the
HTTP transport the obsidian-tc **companion plugin** rides (the companion registers its
bridge routes onto LRA's server; without LRA the bridge routes are not registered).

## 1. Why

obsidian-tc is a capability superset of the retired servers with governance none of them
have. Every capability the old surfaces offered — vault CRUD and section-targeted patch,
text/DQL/semantic search, tags and frontmatter, Templater execution, command dispatch —
exists as a first-class obsidian-tc tool, plus a large surface they never had (canvas,
Bases with a real expression-DSL evaluator, attachments, bookmarks, workspaces, periodic
notes, Excalidraw, OCR, Tasks, bulk ops, capture queue, memory entities, GraphRAG
`vault_graph_search`, `knowledge_challenge`). Critically, every call runs through one
governed dispatch pipeline the wrappers lack entirely: auth (JWT, including asymmetric
RS256/ES256/EdDSA via a local JWKS with `kid` rotation, THE-297) → scopes → folder ACL
(canonical/symlink-resolved, NFC-normalized, hard-deny on `.obsidian/**`, `.git/**`,
`.trash/**`, now **per-vault** with the root ACL as inherited default, THE-286/295) →
read-only kill switch → idempotency → throttle → HITL elicitation on destructive ops →
response governor → audit, with OTel/Prometheus/CloudEvents observability and compute
budgets (regex worker timeout, JSONLogic op budget, THE-293). The retired servers
authenticate with a single LRA bearer key that is equivalent to full vault admin
(documented trust boundary, THE-289) and offer no path scoping, no HITL, no audit, and no
index health signal. Consolidating on obsidian-tc removes three ungoverned write paths
into the vault and leaves exactly one.

## 2. Capability map

Every obsidian-tc tool named below exists in `packages/server/src/tools/` (verified
against source).

### 2a. LRA-MCP surface → obsidian-tc

The LRA MCP surface is a thin projection of the REST endpoints (vault file CRUD/patch,
search, active file, commands, periodic notes). Mapping by capability:

| LRA-MCP capability | obsidian-tc equivalent |
|---|---|
| Read a note / batch read | `read_note`, `read_notes` |
| List vault files / folders | `list_notes` |
| Create / overwrite a note | `write_note` (CAS via `prev_hash`) |
| Append to a note | `append_note` |
| Patch a note (heading / block / frontmatter target) | `patch_note` |
| Delete a note | `delete_note` (HITL-gated, delete-tier throttled) |
| Move / rename a note | `move_note` (backlink rewrite + reindex), `copy_note` |
| Existence check | `note_exists` |
| Simple text search | `search_text` (FTS5-trigram accelerated when `notes_ready`), `search_vault` (unified `mode` dispatcher) |
| Tags (list / add / remove / find) | `list_tags`, `get_note_tags`, `add_tag`, `remove_tag`, `find_notes_by_tag` |
| Frontmatter / properties | `read_frontmatter`, `read_property`, `update_frontmatter`, `list_properties`, `find_notes_by_property` |
| Command palette (list / execute) | `list_commands`, `execute_command` (companion-backed, policy-gated) |
| Periodic / daily notes | `get_periodic_note`, `create_periodic_note`, `find_or_create_periodic_note`, `append_to_periodic_note`, `list_periodic_notes` |
| Active file get / update / patch / delete | **Not covered** — see §2c |
| Server info | `server_health`, `get_server_config` |

Beyond parity, obsidian-tc adds links (`get_outgoing_links`, `get_backlinks`,
`find_orphans`, `find_unresolved_links`, `rewrite_link`, `prune_hub_links`), attachments
(`list_attachments`, `get_attachment`, `move_attachment`, `delete_attachment`), canvas
(`read_canvas`, `create_canvas`, `update_canvas`, `query_canvas`), Bases (`read_base`,
`create_base`, `update_base`, `query_base` — evaluates the real Obsidian 1.12 Bases
expression-DSL subset, THE-281, with realigned `order`/`sort`/`limit`/`groupBy` view keys
and deprecation notices for the old aliases, THE-280), bookmarks, workspaces, bulk ops
(`bulk_create_notes`, `bulk_set_property`, `bulk_move_notes`), multi-vault registry
(`list_vaults`, `get_vault`, `reload_vault`, `reset_vault_cache`), `bundle_folder`/
`bundle_files`, OCR (`ocr_attachment`, `ocr_bulk`), Tasks (`list_tasks`, `update_task`,
`tasks_filter`), capture (`enqueue_capture`, `commit_capture`), and admin
(`inspect_acl`, `get_metrics`, `index_vault`).

### 2b. mcp-tools 0.2.33 → obsidian-tc

| mcp-tools capability | obsidian-tc equivalent |
|---|---|
| Vault file CRUD (`get/create/append/patch/delete_vault_file`, `list_vault_files`) | `read_note`, `write_note`, `append_note`, `patch_note`, `delete_note`, `list_notes` |
| Dataview DQL (`search_vault`) | `search_dql` / `search_vault(mode: dql)` — read-only by contract, companion-bridged, fail-closed under a read whitelist |
| JsonLogic search | `search_jsonlogic` — native evaluator with a 10k-op compute budget (THE-293), no plugin required |
| Simple search (`search_vault_simple`) | `search_text` / `search_vault(mode: text)` |
| Semantic search (`search_vault_smart`, requires the Smart Connections plugin) | `search_semantic` — **sqlite-vec-native** KNN with SQL-side vault filtering and an ACL-correct brute-force fallback (THE-287); embeddings via local Ollama by default. Independent of Smart Connections — retiring mcp-tools does not lose semantic search even if Smart Connections is removed. |
| Templater (`execute_template`) | `list_templates`, `execute_template` — companion-bridged; the server now refuses to clobber an existing target unless `overwrite: true` (THE-289) |
| `get_server_info` | `server_health` |
| Active-file tools, `show_file_in_obsidian` | See §2c |
| `fetch` (web fetch) | Not carried over — out of scope for a vault server; the agent host provides web tools |

### 2c. UI-coupled gaps (honest notes)

These LRA-MCP / mcp-tools capabilities depend on the Obsidian **UI session** and have no
full obsidian-tc equivalent today:

- **Active file (get / update / append / patch / delete the currently-open note).**
  Not covered. obsidian-tc tools are path-addressed; there is no `get_active_file`
  equivalent in `packages/server/src/tools/`. Workflow change: the agent asks for (or is
  told) the note path and uses the path-addressed tools.
- **Open / reveal a file in Obsidian (`show_file_in_obsidian`).** Partially covered:
  `generate_uri` (action `open`, plus `search`/`new`/`daily`/`command`/`hookmark`/
  `advanced`) builds the exact `obsidian://` URI — but it is a pure string builder; the
  server does not launch it. The user (or a host-side shell step) opens the URI.
  `execute_command` can dispatch any command-palette command via the companion, but it is
  not file-targeted.
- The opt-in companion "refresh nudge" for open panes is designed but deferred
  (THE-283, `docs/COHERENCE.md`).

If active-file workflows are load-bearing for you, keep that one workflow on the old
surface until a companion-backed active-file bridge ships; everything else cuts over now.

## 3. Cutover steps

1. **Install the server.**
   ```bash
   npm install -g obsidian-tc     # Node >= 24, or Bun >= 1.1 (runtime auto-detected)
   ollama pull nomic-embed-text   # default local embeddings model
   ```
   (Alternatives: `npx -y obsidian-tc`, the `.mcpb` one-click bundle, or the standalone
   per-platform binaries attached to each GitHub release.)

2. **Configure vault(s) + ACL.** Zero-config works (`obsidian-tc /path/to/vault` boots a
   single vault `main`); for the cutover, write a config so ACLs are explicit. Per-vault
   ACL is supported (THE-295): each `vaults[]` entry may carry its own `acl` block, and
   the root `acl` is the inherited default — "write vault A, read-only vault B" works in
   one process.
   ```json
   {
     "vaults": [
       {
         "id": "second-brain",
         "path": "C:/path/to/your/vault",
         "restApiUrl": "https://127.0.0.1:27124",
         "restApiKey": "<LRA bearer key>",
         "acl": { "writePaths": ["Projects/**", "Inbox/**"] }
       },
       { "id": "archive", "path": "C:/path/to/another/vault", "acl": { "readOnly": true } }
     ],
     "acl": { "strictReadDefault": false }
   }
   ```
   ACL fields: `readOnly`, `readPaths`/`writePaths`/`deletePaths` glob whitelists,
   `rules`, `strictReadDefault`. `.obsidian/**`, `.git/**`, `.trash/**` are hard-denied
   regardless (THE-268); matching is symlink-canonical and NFC-normalized (THE-269/272/286).
   Validate: `obsidian-tc config validate ./obsidian-tc.config.json` and inspect with
   `obsidian-tc config show` (secrets redacted).

3. **Install the companion plugin** (bridge for commands, Templater, Dataview DQL,
   Excalidraw, QuickAdd, make.md, Tasks DSL, OCR):
   ```bash
   obsidian-tc plugin install --vault "C:/path/to/your/vault"
   ```
   This copies the vendored `manifest.json` + `main.js` into
   `<vault>/.obsidian/plugins/obsidian-tc/` (plugin id `obsidian-tc`, name "Obsidian
   Turbocharged"; re-running is an in-place upgrade). Then enable it in Obsidian's
   Community Plugins. It requires the **Local REST API** plugin installed and enabled —
   the companion extends LRA's HTTP server; without LRA it logs a warning and registers
   no bridge routes. The server enforces a companion API floor via `/probe` (THE-282): an
   incompatible companion degrades bridge tools with a typed `plugin_incompatible` error
   and an update hint, never silent divergence.

4. **Verify `server_health`.** Start the server (`obsidian-tc ./obsidian-tc.config.json`)
   and call `server_health`. Expect:
   - `status: "ok"`, `version`, `vault_count` (and `vaults` when authenticated);
   - `native_loaded` — compiled Rust search primitives (pure-JS fallback otherwise);
   - `vec_enabled` — sqlite-vec loaded (brute-force cosine fallback otherwise);
   - `fts_enabled` — FTS5 `notes_fts` available (disk-scan fallback otherwise);
   - the `index` block (THE-288/291): `reconcile` (`pending`/`ok`/`degraded`),
     `reconcile_at`, `write_failures`, `notes_ready`; authenticated callers also get
     `detail` (per-vault reconcile errors + last write error).
   All fallbacks are behavioral no-ops (identical results, slower) — but a `degraded`
   reconcile or growing `write_failures` should be investigated before retiring the old
   surface.

5. **Point Claude (and other MCP clients) at obsidian-tc over stdio.**
   ```json
   {
     "mcpServers": {
       "obsidian-tc": {
         "command": "npx",
         "args": ["-y", "obsidian-tc"],
         "env": { "OBSIDIAN_TC_CONFIG": "/ABSOLUTE/PATH/TO/obsidian-tc.config.json" }
       }
     }
   }
   ```
   (Claude Code: `claude mcp add obsidian-tc -e OBSIDIAN_TC_CONFIG=... -- npx -y obsidian-tc`.
   Cursor uses `mcpServers`, VS Code uses `servers`; `.mcpb` for Claude Desktop.)
   The stdio transport is the trusted local transport with full multi-vault access;
   HTTP is opt-in and, when used, tokens are vault-bound (THE-267).

6. **Retire the old surfaces.** Remove the MCP client entries for the LRA-MCP server
   (e.g. `obsidian` / `obsidian-files`), for `obsidian-mcp-tools`, and for the
   obsidian-headless / CLI wrapper (e.g. `obsidian-cli`) from every client config
   (`claude mcp remove ...`, `~/.cursor/mcp.json`, `.vscode/mcp.json`, Claude Desktop).
   Uninstall the mcp-tools server binary/plugin from the vault. In the Local REST API
   plugin settings, disable its bundled MCP exposure if present — its **REST** endpoints
   stay on.

7. **Keep LRA enabled — it is now transport only.** The companion rides it; obsidian-tc
   reaches it via each vault's `restApiUrl`/`restApiKey`. Trust boundary (THE-289,
   SECURITY.md): possession of the LRA bearer key is equivalent to full vault admin —
   LRA's own endpoints grant full read/write/delete, and the companion routes add no new
   authority and deliberately do not re-implement the server's ACL/HITL gates (those
   protect the MCP surface). So: keep LRA bound to loopback, guard the key like a vault
   password, and hand agents the obsidian-tc surface, never the LRA key.

## 4. Rollback

Nothing in the cutover is destructive; rollback is configuration-only:

1. Re-add the removed MCP client entries (LRA-MCP, mcp-tools, obsidian-headless) — the
   plugins/servers were disabled/uninstalled, not data-modified, and LRA itself was never
   disabled.
2. Optionally remove the obsidian-tc entry from client configs and stop the server.
3. Vault content is untouched by rollback: obsidian-tc writes notes atomically
   (temp+rename) to the same Markdown files the old servers used, so both directions read
   the same source of truth. Its own state lives outside note content in the cache dir
   (default `.obsidian-tc/` — `cache.db` holding the index, embeddings, and event log,
   plus per-vault MORGIANA audit-spool JSONL); it can be left in place (inert) or deleted
   (the index is rebuilt by the boot reconcile on the next start).
4. The companion plugin can stay installed and enabled during rollback — it only adds
   bridge routes to LRA and does nothing when the server is not calling it.

## 5. The Sync story

**obsidian-tc does not do Obsidian Sync — keep your existing sync mechanism.** The server
operates on the local vault filesystem (single filesystem `VaultBackend`; the companion/
LRA are Tier-3 bridge-only). It neither replaces nor interferes with Obsidian Sync,
Syncthing, iCloud, or Git-based sync: those keep replicating the same files obsidian-tc
reads and writes. Two coherence notes (THE-283, `docs/COHERENCE.md`):

- The sole-agent-writer invariant: obsidian-tc's compare-and-swap gates (`prev_hash` on
  note writes and, since THE-292, on bookmark/workspace JSON edits) defend against the
  remaining human-writer concurrency; do not run a second agent writer against the vault.
- Obsidian's external-change watcher has honest limits: an open pane may not refresh
  until navigated, and change detection degrades on OneDrive/network drives. Sync engines
  that write while a note is open are subject to the same Obsidian-side behavior they
  always were — obsidian-tc changes nothing here.
