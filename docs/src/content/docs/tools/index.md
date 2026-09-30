---
title: Tool Reference
description: The tool surface obsidian-tc exposes to MCP clients, and the facade that shapes it.
---

obsidian-tc groups **its tools across modules M1–M8 plus admin**. Every tool has
a Zod-validated input schema, a structured result, a declared scope set, and a
scope class that selects its rate-limit tier. `tools/list` also derives MCP
**annotations** (`readOnlyHint` / `destructiveHint` / `openWorldHint`) and a
`title` from registry ground truth, and a tool may carry an optional `outputSchema`
and `icons`. Advertised schemas are **JSON Schema 2020-12** (the MCP `2025-11-25`
default dialect), matching the negotiated protocol version.

For how to connect and call these over MCP — stdio or HTTP, auth, and the discover → describe → call flow — see the [API Reference](/tools/api-reference/).

## Tool-surface facade

What `tools/list` advertises is controlled by `toolFacade.mode`:

- **`triad`** (default) — three meta-tools: `find_capability` (BM25 search over the
  catalog), `describe_capability` (a tool's schema + scopes), and `call_capability`
  (invoke by name). Discover, inspect, then call.
- **`domain`** — ~a dozen domain meta-tools (`notes`, `search`, `vault`, …), each
  taking `{ action, args }`.
- **`flat`** — the full underlying surface.
- **`auto`** — picks one of the three above **per connecting client**, from its
  observed MCP `clientInfo.name`, and caches the choice for the rest of that
  client's session once a NAME is actually observed (a request that carries no
  observable name at all gets the `triad` fallback WITHOUT pinning the
  connection to it — the first later request that does carry a name still
  resolves for real). `toolFacade.autoClients` maps a case-insensitive
  substring of the client name to a mode (checked in the config's own key
  order, before the built-in table below — a match here overrides the same
  substring there); a client matching nothing gets `triad`. The built-in table
  is:

  **Where `auto` actually resolves.** Client identity is observed per request
  from the MCP request envelope (or, for a legacy client, from the
  `initialize` handshake). On **stdio**, one connection is served by ONE
  long-lived `Server` instance for its whole life, so `auto` resolves on
  either protocol era — a legacy client's `initialize`-only identity is still
  seen. On **Streamable HTTP**, every request is served by a brand-new,
  stateless `Server` instance with no memory of any earlier request on that
  same TCP connection: a 2026-07-28 client resolves correctly because it
  resends `clientInfo` in `_meta` on every request, but a 2025-11-25 (legacy)
  client over HTTP only ever declares `clientInfo` at `initialize` — a
  DIFFERENT `Server` instance than the one that later serves `tools/list` — so
  it always gets the untargeted `triad` fallback. `auto` is therefore precise
  on stdio (both eras) and on HTTP for 2026-07-28 clients; a legacy client
  connecting over HTTP should set `toolFacade.mode` explicitly instead of
  relying on `auto`.

  | Client name contains | Mode | Why (provisional) |
  | --- | --- | --- |
  | `claude-code` | `domain` | Ships its own client-side tool search, so the triad's find/describe layer duplicates it — domain's grouped meta-tools give it real verbs to search over instead. |
  | `cursor` | `triad` | A 40-tool cap has been reported but is unverified — kept at the existing default. |
  | *(anything else)* | `triad` | The existing, ADR-anchored default. |

  **This table is a starting point, not a measurement.** Nothing here has yet
  measured tool-*selection* accuracy per client — only per raw tool count (see
  `docs/adr/0006-the-default-surface-is-the-triad.md`). A follow-up ticket will
  replace it with per-client data; until then, override any entry with
  `toolFacade.autoClients` in your config.

  **Explaining an `auto` decision.** Set `toolFacade.explainAutoMode: true`
  (default `false`) to see why a client got the mode it did, without changing
  it. Each resolution writes one `obsidian-tc toolFacade.explain {...}` JSON
  line to stderr, and the `explanation` field of `server_health`'s `toolFacade`
  block returns the same record for the calling client. The record lists the signals the matcher
  actually reads — the observed `clientName` (name only, bounded and stripped of
  control characters), the `configuredKeys` from `toolFacade.autoClients` and the
  `builtInKeys` it checked, in match order — plus the `rule` that fired
  (`no-client-name`, `configured-override`, `built-in-table` or `no-match`), the
  `matchedKey`, the `fallback`, and the `mode` chosen. Tool-search support is
  not a separate input: the built-in table above encodes it per client name.
  Tool count, tags and `toolFacade.profile` do not affect the decision and so
  do not appear. `obsidian-tc doctor` (offline) reports the flag and warns when
  it is set under a mode other than `auto`; the live, per-client view is
  `server_health`.

Every underlying tool stays callable by name in every mode, and `tools/list` is
filtered per caller scopes + tool-visibility ACL. Routing always goes through the
same authorization / ACL / HITL / idempotency / throttle pipeline.

## Tool profile

`toolFacade.mode` (above) picks what a given **session** is advertised. A separate,
deployment-level setting, `toolFacade.profile`, picks which tools are **visible and
callable** at all. Registration itself never changes — every tool is always
registered (`server_health`/`inspect_visibility` can always name all 164) — only
dispatch-time visibility does:

- **`full`** (the default) — every tool stays visible/callable, exactly as today.
  **This ticket does not change the default.** A usage report over 4,787 recorded
  calls (GitHub issue #877) found 97 of 164 tools never called once — but it names
  only five tools as confirmed zero-call, not whole families, and the same
  reporter separately filed a whole issue (#879) praising one of the tools an
  earlier draft of this feature would have hidden. Flipping the default needs its
  own evidence-gated decision, not a side effect of adding the mechanism — see
  `docs/adr/` for that bar.
- **`core`** (opt-in) — a smaller, curated surface for an operator who wants one.
  Five graph-analysis tools (`graph_centrality`, `graph_communities`,
  `suggest_links`, `find_link_cycles`, `prune_hub_links`) are the ONLY ones with
  direct usage evidence behind the cut (#877 names them explicitly as zero-call).
  The rest of the curation — the structured-document family (Bases, Canvas,
  Kanban, periodic notes, bookmarks, attachments, tables) and the plugin-bridge
  family (Excalidraw, MakeMD, Remotely Save, OCR, git, Templater, QuickAdd,
  Dataview, and siblings) — is a STRUCTURAL choice (every member proxies to a live
  companion plugin and degrades when it is absent), not a usage claim; #877 gives
  no evidence either way for these. `bundle_files`/`bundle_folder` stay in `core`
  despite living in the plugin-bridge domain: both are pure filesystem (no
  companion dependency) and `bundle_folder` has direct positive usage evidence
  (#879). Everything the triad facade, the memory tools (M5/M7/M8), catalog
  discovery, health/admin, or the HITL/elicit flow depends on stays in `core`
  regardless of usage. See `packages/server/src/mcp/tool-profiles.ts`'s module
  comment for the full accounting, including the caution that a documented history
  of plugin-bridge integration bugs (companion routes 404ing, a wrong plugin-id
  mapping) means zero calls to that family cannot be read as zero want.

A tool `core` hides is not silently missing: `find_capability` discloses a
profile-hidden match by name and count when your query matches one;
`describe_capability`/`call_capability` on one by name both answer a
`capability_hidden` error naming the config key, never a bare "not found" and
never a silent dispatch; `inspect_visibility` reports `disabled_by_profile`.
`toolFacade.profile` is the default (`"full"`) unless you set it — no migration
needed.

## Tool tags

Every tool carries a set of tags, and `toolVisibility.hiddenTags` / `disabledTags` act on them.
Naming a tag in `hiddenTags` drops its tools from `tools/list`, `find_capability`, the
`obsidian-tc://catalog` resource and the domain meta-tools while leaving them callable by name;
naming it in `disabledTags` also rejects the call, as if the tool were never registered. Each
tool's page in the [Tool Catalog](/tools/tool-catalog/) lists its tags, and `describe_capability`
returns them as `tags`.

Most tags are **derived** at registration from what the tool already declares, so they cannot
drift: a tool's scopes say whether it writes, its destructive and confirmation flags say whether
it can destroy data, and its facade domain gives its `domain:` tag. A few facts no other field
carries are **declared** on the tool definition. Registration refuses a tag outside this
vocabulary, a derived tag written by hand, and a declaration the derivation already makes.

| Tag | Source | Meaning |
| --- | --- | --- |
| `read-only` | derived | Does not mutate the vault: no write, delete, bulk or execute scope, and not destructive. The same test as the read-only gate and the MCP `readOnlyHint`. |
| `writes` | derived | Mutates the vault. The complement of `read-only`. |
| `destructive` | derived | Can destroy data, always or on some calls (the MCP `destructiveHint`). |
| `hitl` | derived | Needs a human confirmation token, always or when a call crosses a boundary. |
| `bulk` | derived | Holds a `bulk:*` scope: one call changes many notes. |
| `admin` | derived | Holds an `admin:*` scope: administers the server, its vaults, ACLs, config or metrics. It may change server state without modifying notes, so it can also be `read-only`. |
| `domain:<name>` | derived | Belongs to that facade domain, for example `domain:git` or `domain:notes`. |
| `plugin-bridge` | derived and declared | Needs the Obsidian companion plugin, so a live Obsidian session. Derived from a scope that names a plugin; declared for the few bridge tools whose scope is a generic vault scope. |
| `external-network` | declared | The tool's handler may send query or note text to a service outside the server process: a hosted embedding provider, or a cloud sync plugin. Indexing that runs in the background after a write is not attributed to the tool that triggered it. |
| `experiential` | declared | Reads or writes the derived work-memory plane. |
| `verdict` | declared | A verdict verb: its calls are recorded as verdicts, never as evidence for later retrieval. |
| `knowledge` | declared | Part of the knowledge-retrieval surface. |
| `search` | declared | Retrieves notes or chunks by query. |
| `docs` | declared | Reads the external vendor-docs corpus. |
| `links` | declared | Reads the link graph. |
| `graph` | declared | Computes graph analytics over the link graph. |
| `provenance` | declared | Reports where an answer came from. |
| `diagnostics` | declared | Explains or audits retrieval behaviour. |

For example, `hiddenTags: ["destructive"]` keeps every tool that can delete or overwrite out of a
client's discovery, and `disabledTags: ["external-network"]` makes a deployment that must not call
a hosted embedding provider refuse those tools outright.

## Domains

| Group | Domains | Examples |
| --- | --- | --- |
| **Notes & metadata** (5 tools `full`-only) | notes, frontmatter, properties, tags, links, headings | `read_note`, `write_note`, `patch_note`, `update_frontmatter`, `get_backlinks`; graph analysis is `full`-only: `graph_centrality`, `graph_communities`, `suggest_links`, `find_link_cycles`, `prune_hub_links` |
| **Search & retrieval** | text search, DQL, vector / hybrid search, embeddings | `search_vault`, `search_dql`, `search_semantic` |
| **Structured formats** (`full`-only) | Bases, Canvas, periodic notes, bookmarks, outlines | `read_base`, `update_canvas`, `create_periodic_note`, `list_bookmarks` |
| **Plugin bridges** (`full`-only) | Dataview, Templater, OCR, command execution, tasks, workspace | `eval_dataview_field`, `execute_template`, `execute_command`, `list_tasks` |
| **Memory & capture** | memory store, capture queue, workspace traces, PLUR proxy | `add_observation`, `enqueue_capture`, `plur_recall` |
| **Knowledge & context** | GraphRAG, composite context, reflection, red-team challenge | `vault_graph_search`, `vault_context`, `reflect`, `knowledge_challenge` |
| **Work memory (experiential)** | quarantined agent-episode store with an eligibility-gated reader contract | `work_search`, `work_episodes`, `work_forget`, `record_retrieval_feedback` |
| **Git & sync bridges** (`full`-only) | Obsidian Git (commit is HITL-floored), Remotely Save backup signal | `git_status`, `git_diff`, `git_commit`, `remotely_save_status` |
| **Bulk & URI** | bulk note create / move / set-property, `obsidian://` URI generation, plus `bundle_files`/`bundle_folder` (filesystem-only, kept in `core`) | `bulk_create_notes`, `bulk_move_notes`, `bulk_set_property`, `generate_uri`, `bundle_folder` |
| **Server admin** | health, config, ACL, metrics introspection | `server_health`, `get_server_config`, `inspect_acl`, `get_metrics` |

See the [Tool Catalog](/tools/tool-catalog/) for the per-tool Profile column (generated from
`tool-profiles.ts`, the single source of truth this table's `full`-only markers also read from).

## Degradation & errors

A tool that needs an unavailable capability (a missing plugin, an unconfigured
embedding provider) returns a typed error from the shared `ObsidianTcError`
taxonomy (e.g. `plugin_missing`, `embedding_provider_error`) with a `retryable`
flag and a bounded `recovery` hint naming the next step — it never throws an
opaque failure. At the MCP boundary a dispatch failure
surfaces as a **Tool Execution Error** (`isError: true` with human-readable text
plus the structured error as `structuredContent`), so a model can self-correct
rather than seeing a protocol error.

:::note
Per-tool reference pages auto-generated from the live `ToolRegistry` and its Zod
schemas are a deferred follow-up. This page is the curated overview.
:::
