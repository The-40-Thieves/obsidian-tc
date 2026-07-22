# Plugin Bridges

Many tools reach Obsidian plugins through the **companion plugin**, which extends the [Local REST API plugin](https://github.com/coddingtonbear/obsidian-local-rest-api) with `/obsidian-tc/v1/*` routes. Direct file ops (`read_note`, `write_note`, search over the cache, …) work without it; **bridge** tools additionally need the companion plugin plus the specific third-party plugin.

Install the companion with `obsidian-tc plugin install --vault /path/to/vault`, then enable it in Obsidian — see **[[Installation]]**.

## Dependency chain

```
Obsidian app                 (always required for bridges)
  Local REST API plugin       (always required - HTTP entry to the live app)
    Companion plugin          (required for command palette + ANY bridge tool)
      Dataview                -> search_dql, validate_dql, eval_dataview_field
      Tasks                   -> tasks_filter
      Templater               -> list_templates, execute_template
      QuickAdd                -> list_quickadd_actions, trigger_quickadd
      Text Extractor          -> ocr_attachment, ocr_bulk
      Smart Context           -> bundle_folder, bundle_files
      Excalidraw              -> excalidraw tools (a filesystem read path also exists)
      Periodic Notes          -> periodic_note tools
      Workspaces (core)       -> workspace tools
      Bookmarks (core)        -> bookmark tools
      make-md                 -> makemd_list_spaces, makemd_query
      Obsidian Git            -> git_status, git_diff, git_log, git_stage, git_commit
      Remotely Save           -> remotely_save_status, remotely_save_trigger
```

A tool that fails any link in the chain returns `plugin_missing` with the specific plugin in `details.plugin` (or `plugin_unreachable` if the plugin is present but its endpoint times out).

## Git & sync bridges (v1.7)

- **Obsidian Git** — read tools (`git_status`, `git_log`) need `read:git`; `git_diff` enforces per-path read ACL; `git_stage` needs `write:git` with per-path write ACL; **`git_commit` sits on the execute-family HITL floor** — it always requires human confirmation, regardless of configured thresholds.
- **Remotely Save** — `remotely_save_status` reads the sync state (`lastSuccessSync`) as an independent backup-verification signal; `remotely_save_trigger` fires a sync (write-scoped).

## Companion plugin

A standard Obsidian plugin (`@the-40-thieves/obsidian-tc-plugin`) that owns command-palette dispatch, active-file access, and the per-plugin bridge endpoints. It declares `obsidianTcApiVersion: "1"`; the server reads this from the probe and refuses to dispatch on a major mismatch (`plugin_incompatible`). Routes are path-versioned (`/v1/`) so a future `/v2/` can ship alongside.

## Discovery probe

At server start (and on `reload_vault`) the server fires `GET /obsidian-tc/v1/probe` (500ms timeout). The companion answers with installed plugins + versions, read straight from Obsidian's `app.plugins` — no per-plugin probing — plus per-capability advertising for the bridge families (including git and remotely-save). The server validates that the reported `vault_path` matches config and caches the result in memory for the vault's lifetime. `get_server_config` exposes `plugins_detected` per vault for debugging.

| Probe failure | Behavior |
|---|---|
| 404 (companion not installed) | Bridge tools return `plugin_missing`; direct file ops still work |
| Timeout | Retry once, then mark `bridges_unavailable` |
| Malformed JSON | Treated as 404 |
| API major mismatch | Warn, continue in forward-compat mode |

## Config overrides

```json
"plugins": {
  "forceEnabled": ["dataview", "tasks"],
  "forceDisabled": ["excalidraw"],
  "probeSkip": false
}
```

`forceEnabled` + `probeSkip: true` lets CI assert on tool behavior without booting Obsidian. `forceDisabled` exercises the `plugin_missing` path or operationally disables an expensive bridge.

## Bridge timeouts

Default 5s per route (`vault.bridges.timeoutMs`); OCR and Templater routes default to 30s. A timeout returns `plugin_unreachable`.

## Version compatibility & bridge state (THE-523)

The server and companion plugin form a versioned contract. On first bridge contact the server compares the companion's reported version and Obsidian API major against the supported range; a skew logs **once** at `warn` with the specific incompatibility rather than diverging silently at whichever route changed.

<!-- BEGIN GENERATED: bridge-compat -->
| Contract axis | Supported minimum |
|---|---|
| Companion plugin version | `1.7.0` |
| Obsidian app version (`minAppVersion`) | `1.7.0` |
| Companion API major | `1` |
<!-- END GENERATED: bridge-compat -->

A companion **older** than the minimum, or on a different API major, is a **breaking** skew — the affected bridge tools degrade rather than behave unpredictably. A companion that did not report a version (predating version reporting) is a soft warning; a **newer** companion is fine.

### Bridge state — `live` / `headless` / `degraded`

`obsidian-tc doctor` reports each vault's bridge state with a reason, so an operator can answer *"which mode am I in, and why?"* — the surface no longer silently shrinks to "headless":

| State | Reason | What it means / action |
|---|---|---|
| `live` | `companion-reachable` | Full surface (command dispatch, Templater, …). |
| `headless` | `plugin-not-installed` | Local REST API plugin absent — install it. |
| `headless` | `plugin-disabled` | Installed but disabled — enable it in Obsidian. |
| `headless` | `companion-missing` | No companion detected; running on direct filesystem. |
| `degraded` | `enabled-but-unreachable` | **Enabled on disk but not answering** — reload the plugin inside Obsidian. (Previously an invisible failure.) |
| `degraded` | `companion-unreachable` | Endpoint configured but no answer — check URL/key and that Obsidian is running. |
| `degraded` | `version-skew` | Companion version or API major incompatible — update the companion. |

The `plugin-not-installed` / `plugin-disabled` / `enabled-but-unreachable` distinction is sourced from on-disk detection ([[Environment detection|THE-522]]): three different operator actions that were previously one indistinguishable "headless".
