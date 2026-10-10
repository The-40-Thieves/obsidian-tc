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
default dialect), matching the negotiated protocol version, and lowered to the
subset every client accepts (no `$ref`, `const`, `oneOf`, `allOf` or type arrays;
a plain object root; `anyOf` only on its own). Calls are still validated against
the full schema server-side. Everything a tool returns validates against its
advertised `outputSchema`; an output whose root cannot be a plain object (the
`plur_*` proxies, whose backend may return any JSON value) is listed without an
`outputSchema`. An advertised input schema can be wider than what the server
accepts, because a constraint the lowering has to drop is repeated in that
parameter's description and still enforced; it is narrower in one case only: an
explicit `null` for a nullable optional parameter is accepted by the server but not
advertised.

For how to connect and call these over MCP — stdio or HTTP, auth, and the discover → describe → call flow — see the [API Reference](/tools/api-reference/).

## Tool-surface facade

What `tools/list` advertises is controlled by `toolFacade.mode`:

- **`triad`** (default) — three meta-tools: `find_capability` (BM25 search over the
  catalog), `describe_capability` (a tool's schema + scopes), and `call_capability`
  (invoke by name). Discover, inspect, then call. Two standard knowledge-connector tools
  ride alongside them: `search` and `fetch` (see below), so ChatGPT deep research and
  company knowledge, which only recognise tools by those names, find them without a
  discovery round trip. They are the only tools promoted; hide them with
  `toolVisibility.hidden: [search, fetch]`.
- **`domain`** — ~a dozen domain meta-tools (`notes`, `search`, `vault`, …), each
  taking `{ action, args }`.
- **`flat`** — the full underlying surface.
- **`auto`** — **deprecated; set an explicit mode.** It resolves to `triad` for
  every client, so it is the same as setting `triad` and adds nothing. The
  setting is still accepted, so no existing config breaks, but `obsidian-tc
  doctor` and `server_health` report it as deprecated, and it will be removed in
  the next major version. An operator's own `toolFacade.autoClients` entry (a
  case-insensitive substring of the client's `clientInfo.name` mapped to a mode,
  checked in the config's own key order) still takes effect under `auto` and is
  deprecated with it.

  **Why.** The built-in per-client table used to send `claude-code` to `domain`.
  The measurement that followed does not support that pick: with Claude Code's
  own tool search on, `domain` matched `triad` on success and added argument
  validation errors in every trial (the model cannot see a domain action's schema
  before calling it), and `flat` cost about 38% more billable tokens. No mode beat
  `triad` by the pre-registered margin. The project also decided against
  client-sniffing: MCP 2026-07-28 says list endpoints no longer vary per
  connection. Set one explicit `toolFacade.mode` per client; see
  [Choosing a facade mode per client](/getting-started/mcp-clients/#choosing-a-facade-mode-per-client)
  for the measured recommendations (`triad` for Claude Code, `domain` for Codex).

  **Explaining an `auto` decision.** `toolFacade.explainAutoMode: true` (default
  `false`) writes one `obsidian-tc toolFacade.explain {...}` JSON line to stderr
  per resolution, and the `explanation` field of `server_health`'s `toolFacade` block returns the
  same record for the calling client: the observed `clientName` (bounded, control
  characters stripped), the `configuredKeys` and `builtInKeys` checked, the
  `rule` that fired (`no-client-name`, `configured-override`, `built-in-table` or
  `no-match`), the `matchedKey`, the `fallback` and the `mode` chosen.
  The same block carries a `deprecation` notice whenever the configured mode is
  `auto`. `obsidian-tc doctor` warns that `auto` is deprecated
  and, separately, warns when `autoClients` or `explainAutoMode` is set under a
  mode other than `auto`.

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

## Tool-budget profiles

Some clients cap how many tools they accept: Antigravity and Windsurf 100, Gemini
Enterprise 100 actions, VS Code, Copilot Studio and Vertex 128 per request, and Codex
defers everything past 100. A client can pick an **advertised subset** per URL on the
HTTP transport, or you can set one for the whole server with `toolFacade.advertise`
(default `"all"`, which narrows nothing). A subset is advertised flat, whatever
`toolFacade.mode` says, and it is advertisement only: a tool outside it stays
registered, authorized as always, and callable by name. This is different from
`toolFacade.profile`, which decides what is callable at all.

| URL | Advertises | Notes |
| :-- | :-- | :-- |
| `/mcp` | what `toolFacade.mode` / `advertise` say (the triad by default) | unchanged |
| `/mcp/triad`, `/mcp/domain` | the triad, or the domain meta-tools | for a server whose default is something else |
| `/mcp/essentials` | about 35 curated tools, flat | one or two per domain, none needing a companion plugin; fits 100-tool caps. `search` and `fetch` join it when the server registers them |
| `/mcp/core` | the `core` curation above, flat (101 tools) | fits 128-tool caps, not 100 |
| `/mcp/full` | every registered tool, flat | for clients with no cap, or that defer-load |

An unknown name under `/mcp/` answers 404. The URL wins over `toolFacade.advertise`.
Stdio has no URL, so it selects a subset by config only. OAuth-protected deployments keep
one resource (`auth.resource`, the `/mcp` URL): every `/mcp/<name>` URL is also a name for it. A
client given `/mcp/essentials` is challenged with, and signs in against, metadata whose `resource` is
that URL, and a token for any of these URLs works on every surface, as profiles change what is
advertised and never what is authorized. See
[Profile URLs and OAuth](/security/auth-model/#profile-urls-and-oauth).

The server `instructions` open with one routing sentence for the surface the client was
given, complete inside the first 512 characters (Codex truncates there) and well inside
Claude Code's 2,048. The triad's three tools, and the `search` and `fetch` advertised beside them, carry `_meta` `"anthropic/alwaysLoad": true`
so Claude Code loads them upfront instead of behind its tool search.

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
| `external-network` | declared | The tool's handler may send query or note text to a service outside the server process: a hosted embedding provider, an LLM judge (the gateway or TypeSafe), or a cloud sync plugin. Indexing that runs in the background after a write is not attributed to the tool that triggered it. |
| `client-sampling` | declared | The tool asks the calling client's own model to run a completion (MCP sampling) and sends it note text the caller may already read. The client decides whether to prompt its user and whose tokens pay for it. The tool has a non-sampling fallback, so `disabledTags: ["client-sampling"]` removes it only for deployments that want no sampling request at all. |
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
| **Notes & metadata** (6 tools `full`-only) | notes, frontmatter, properties, tags, links, headings | `read_note`, `write_note`, `patch_note`, `update_frontmatter`, `get_backlinks`; graph analysis is `full`-only: `graph_centrality`, `graph_communities`, `suggest_links`, `find_link_cycles`, `prune_hub_links`; `suggest_tags` (client-sampled tag suggestions) is `full`-only too |
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

## Property links (Obsidian parity)

The link tools (`get_outgoing_links`, `get_backlinks`, `find_unresolved_links`, `find_orphans`,
`vault_health_score`, `rewrite_link` and the backlink update in `move_note`) see the wikilinks a note
keeps in its **properties**, the way Obsidian does (`CachedMetadata.frontmatterLinks`, Obsidian 1.4.0
and later), not only the ones in its body. The graph index records them too.

```yaml
---
author: "[[Douglas Adams]]"
related:
  - "[[The Hitchhiker's Guide]]"
  - "[[Dirk Gently|Dirk]]"
---
```

- **Quote the link.** Obsidian's own rule ("internal links must be surrounded by quotes"): a quoted
  `"[[X]]"` is a YAML string and counts; an unquoted `author: [[X]]` is a nested YAML list, not a
  link, in Obsidian and here.
- **Which values count.** A wikilink inside any string value: a text property, any item of a list
  property, or a string nested in a mapping. The syntax is the body's: `[[X|alias]]`, `[[X#Heading]]`
  and `[[X#^block]]` resolve the same way. Numbers, booleans and dates hold no links.
- **How they appear.** A property link carries `source: "property"` and `property`, the top-level
  property it sits under (a nested value reports its top-level key). A body link has neither field, so
  a vault with no property links returns exactly what it always did, in both response formats. A
  property link's `line`/`col` are positions in the note file; a body link's `line` counts from the
  first body line.
- **Same rules as body links.** An unresolved property link is an unresolved link; a link to a note the
  caller cannot read is unresolved exactly like a missing one; a note linked only from a property is not
  an orphan; `move_note` and `rewrite_link` repoint property links and keep their quotes, alias and
  heading.
- **Malformed YAML.** A note whose frontmatter does not parse has no property links (nothing can be
  read from it), is named in the result's `warnings`, and its body links still count.
- **Graph search.** Property links are indexed as `property_link` edges, separate from body
  `links_to` edges. `vault_graph_search` follows them only when `retrieval.densify.includeInWalk` is on
  (the existing gate for edges beyond body wikilinks), so default ranking does not change when a vault
  starts using property links. The graph analysis tools see them regardless. Notes in Obsidian's
  Excluded files stay link targets (a property link to one resolves) and, as for body links, get no graph
  edge.

## Renaming and link-safe names

`move_note`, `bulk_move_notes` and `move_attachment` rewrite the links in every note that pointed at
the old name (`update_backlinks`, `update_references`), and `rewrite_link` rewrites them to a target
you supply. The new name is written into `[[...]]`, `![[...]]` and `[text](...)` in those notes, so
two guards keep a name from becoming link syntax:

- **A new name must be able to live inside a wikilink.** A note or attachment you would CREATE, move,
  rename or copy to (`write_note`, `copy_note`, `move_note`, `bulk_move_notes`, `write_attachment`,
  `move_attachment`, `create_canvas`) may not have a path segment containing `[`, `]`, `#`, `^`, `|`,
  `%%`, a newline or any other control character. The call is refused with `invalid_input`, the
  message names the offending characters (never the name), and nothing is written. This follows
  Obsidian's own link rule, which says a name with `# | ^ : %% [[ ]]` "may not work as a link" (`:` is
  already refused as a Windows-hostile name, `path_invalid`). Only a NEW name is judged: a file or folder
  that already has such a name keeps working, can be read and updated in place, and can be moved or
  renamed away to a safe name.
- **Every rewritten link is proven.** After a rewrite changes a link, the new text is parsed again and
  must be exactly one link, pointing at the intended target, with its heading and alias unchanged and
  nothing around it. Otherwise the call is refused with `invalid_input` and none of the notes are
  changed. This is what protects `rewrite_link`, whose `to_target` is free text: a target such as
  `x]]` followed by a newline and text, or one containing `|`, is refused. A target may still end in
  its own `#Heading`. In a note's properties the new target additionally must not contain `[[`, `]]`,
  `|`, `%%` or a line break.
- **The whole rewrite is planned and proven before anything moves, and committed as one batch.**
  `move_note`, `bulk_move_notes` and `move_attachment` compute every note's new text, prove every
  changed link and scan every body with memoryDefense before they touch a file. If one link cannot be
  written, the call is refused with `invalid_input` naming the note it sits in and the target it would
  have carried, nothing is moved or written (for `bulk_move_notes`, the whole batch is refused), and a
  retry is an ordinary refusal, not an `indeterminate_outcome`. A note you cannot read is never named:
  the refusal says only that such notes exist (`details.hidden_notes: true`, a flag and never a count). A note that cannot be read at all, such as a hard-linked file, is refused the same way, except in `bulk_move_notes` when it is not one of the moves: it is skipped, and the result carries `unreadable_skipped` (a count, never a path) and `unreadable_warning` to say its links were not updated. Notes in a wiki's immutable raw
  folder are skipped and reported before any of this, so an unrepresentable link in one never refuses
  the move. Two things reach the refusal even though the destination's NEW segments pass the name
  check above. A path-qualified link into an EXISTING folder whose name holds `#` or `^` (`C#/Note`)
  would be read as a heading or block reference, so a path-form link must come back from the re-parse
  exactly as written; when the new basename is unique, the bare link `[[Note]]` is written instead and
  the move goes ahead. And a markdown link cannot carry a `)` in its target, since the scanner ends the
  link there and has no `<...>` form: moving a note to `Report (final).md` is refused while a
  `[text](...)` link points at it, and fine while only `[[wikilinks]]` do.
- **The move and its rewrites commit together or not at all.** The moved note and every backlink
  rewrite are written as one batch: each linking note is replaced only if it still holds the bytes the
  plan was made from, and a write error or a concurrent edit rolls the whole batch back, the move
  included. If a linking note changed, or a new one appeared, between the plan and the commit, the plan
  is rebuilt and re-proven once; a second change is refused as `concurrent_modification` with nothing
  moved. Each rewritten note is snapshotted first, so `restore_note` can undo the rewrite. The source
  is deleted last; the steps after the batch (deleting the source, the search-index updates) are the
  only ones with no rollback.

## Wiki checks (page-exists and lint)

Two read-only tools keep a wiki from growing duplicates. Both are advisory: they never write a note
and never block a write, so an agent that ignores them loses nothing. Both are `full`-profile tools
(hidden under `toolFacade.profile: "core"`).

**`find_existing_page`: before `write_note`.** Give it the topic you are about to write about. It
returns a `verdict` and the candidate notes with the evidence for each:

| Verdict | Meaning | Suggested action |
| --- | --- | --- |
| `exists` | Identity evidence names exactly one page: its path or file name, an `aliases` entry, a `wikidata:` property holding the same QID, or its title or H1. | Link to or extend that page. |
| `ambiguous` | Several pages match on identity, or only soft evidence exists: other notes already link the text, or a note is semantically near. | Read the candidates, then decide. |
| `new` | Nothing matched. | Create the page. |

Semantic similarity alone never produces `exists`; the calibration below is why. The [LLM judge](#the-llm-judge) can resolve an `ambiguous` verdict.

**`lint_wiki`: periodic upkeep.** One call runs the existing health checks and a note-level
near-duplicate pass, and returns **proposals**: each is `{ kind, subject, related?, detail,
suggested_action, tool, tool_args?, evidence? }`, where `tool` is the tool that applies the fix. Kinds:
`orphan`, `unresolved_link` (grouped per missing target), `contradiction` (open rows only), `stale`,
`duplicate_chunks`, `missing_sources`, `coverage_gap` (from the latest persisted gap report) and
`near_duplicate`. A check that cannot run (no rollup yet, no embeddings) is listed under `skipped`
instead of failing the call. `response_format: "concise"` drops `detail`, `tool_args` and `evidence`.

**Access rules.** Both tools honour the read ACL (a note the caller cannot read behaves exactly like a
missing one) and Obsidian's Excluded files: an excluded note still counts as a link target and as
identity evidence (its name or alias is a real name to avoid), but never appears as a similarity match
and is never the subject of a `lint_wiki` proposal.

**Scheduled lint (opt-in).** `maintenance.wikiLint.enabled: true` runs the same checks every
`intervalHours` (default 24) over the whole vault, or `folder`, capped at `maxNotes` (default 1500)
for the pairwise pass. It only logs one summary line per vault (proposal counts by kind) and persists
nothing, so it cannot change a note. It is off by default and also needs `maintenance.enabled`.

**Calibration (bge-m3, public evergreen corpus).** The similarity floors were chosen by a
pre-registered study (hash `73c690843c882c0a754da2841d1e88a88886d05e5c02e45a8eb387367d72fa31`):
60 sampled notes, each with an LLM-written topic, rewrite and summary, scored against its 2 nearest
and 2 random other notes, with the first 30 notes for choosing thresholds and the last 30 held out.

| Score | AUC (choose / held-out) | Floor (max recall at precision >= 0.90, chosen split) | Held-out |
| --- | --- | --- | --- |
| Topic to note, best chunk (R2) | 0.774 / 0.833 | 0.708 | 0 pairs predicted |
| Topic to note, mean-pooled note vector (R1) | 0.760 / 0.807 | 0.708 | 0 pairs predicted |
| Note to note (`lint_wiki`) | 0.903 / 0.889 | 0.909 | precision 0.00 (2 false pairs), recall 0.00 |

Best-chunk scoring is used because it was within 0.01 AUC of the mean-pooled vector and needs only a
chunk nearest-neighbour search. The honest reading is that the precision >= 0.90 constraint is only met
at the very top of the score range, where recall is a few percent: in a corpus where every note is on one
subject, near-neighbours and true duplicates overlap. So similarity is **candidate evidence only**
(`ambiguous`, or a `near_duplicate` proposal to review), never a verdict, and a held-out precision below
0.85 is reported as a failure of the band, not tuned away. Over the whole corpus, the best-chunk top 10
holds the source note for 33 of 60 topics, so lower `min_similarity` per call (for example 0.6) to see weaker
candidates. The floors are specific to `BAAI/bge-m3`; on another embedding model treat them as a starting
point.

### The LLM judge

Because similarity cannot decide "same topic", a model can read the candidates. The judge runs through
the gateway `judge` role by default, or through TypeSafe Jev with `wikiJudge.provider: typesafe`
(see [`wikiJudge`](/configuration/config-yaml/)); with neither configured, there is no judge and nothing
changes. For `find_existing_page` it is **off by default** (`wikiJudge.enabled: false`; `judge: true` on a
call turns it on for that call). For `lint_wiki` and the scheduled lint it is **on by default whenever a
judge is configured** (`wikiJudge.lintEnabled: true`, `maintenance.wikiLint.judge: true`); `judge: false`
on a call, or `lintEnabled: false`, turns it off. The scheduled lint itself still needs
`maintenance.wikiLint.enabled: true`.

* **`find_existing_page` `judge`.** Only a verdict of `ambiguous` that rests on soft evidence (similarity,
  link text) is judged; an exact name, alias, `wikidata:` or title match is final and never sent. Up to
  `wikiJudge.maxCallsPerRequest` (1 to 3, default 3) top candidates are judged, each answered
  `same_topic`, `overlapping` or `different` with a one-sentence reason. Exactly one `same_topic` makes the
  verdict `exists` (with `judged_by: { model, verdict, rationale, paths }`); every candidate judged
  `different` makes it `new`; anything else, and any failure, stays `ambiguous`. The prompt tells the
  judge to prefer `overlapping` when unsure.
* **`lint_wiki` `judge`.** Each `near_duplicate` proposal can carry a `judge_verdict` (up to
  `max_judge_calls` per call). `maintenance.wikiLint.judge: true` makes the scheduled pass judge too, capped
  at `maintenance.wikiLint.judgeMaxCalls` per run, and logs the verdict counts. Both default on once a
  judge is configured, because the judge only adds a verdict to a proposal and the daily cap bounds the
  spend. `lint_wiki` now carries the `external-network` tag, so `toolVisibility.disabledTags:
  ["external-network"]` removes it (set `wikiJudge.lintEnabled: false` to keep the tool without the judge),
  and the scheduled pass skips its judge under that tag instead of calling out.
* **TypeSafe Jev (`wikiJudge.provider: typesafe`, experimental).** Jev is asked a Choice question over
  `same_topic`, `overlapping` and `different` and returns probabilities; a pair is `same_topic` when its
  probability reaches `wikiJudge.threshold`, otherwise the likelier of the other two. `model` must be a
  pinned, dotted version (`jev-1.13.0`, never a floating alias) and `threshold` has no default: it is a
  ranking score, not a calibrated probability and not a security control, so tune it on labelled pairs from
  your own vault. It never falls back to the gateway, and a missing key or bad block disables the judge
  with a warning rather than changing provider. The base URL must be `https://` unless it is loopback or
  its exact hostname is listed in `wikiJudge.plainHttpHosts` (a gateway pass-through on a private network;
  see [Plain-http endpoints](/configuration/config-yaml/#plain-http-endpoints-plainhttphosts)). The same
  egress rules apply as for the gateway judge.
* **Caps.** `wikiJudge.maxCallsPerDay` (default 200, `0` disables) bounds gateway calls per UTC day across
  every caller; a failed call counts, and the call is reserved before it is sent. `wikiJudge.timeoutMs`
  (default 15000) is a per-call deadline that also cancels the gateway request. `wikiJudge.maxNoteChars`
  (default 2400) cuts each side of a comparison, so one call has a bounded size. Over a cap, or on any
  error, the verdict stays `ambiguous` and the tool still answers.
* **Cache.** One verdict per (subject, candidate, resolved model) in `cache.db`, keyed on content hashes:
  editing a note or a gateway repoint of the `judge` alias (the resolved `provider/model` is recorded, never
  the alias) re-asks; a repeat costs nothing. No page text is stored.
* **Privacy.** The topic and the opening text of the candidate pages (at most `maxNoteChars` each) go to the
  judge (the gateway model, or TypeSafe with `provider: typesafe`). A note is sent only if the caller may read it (ACL), it is outside `egress.excludePaths`
  and outside Obsidian's Excluded files; such notes are never sent and are listed as `unjudged`. `maxCallsPerDay: 0`
  or no judge configured keeps everything local. `obsidian-tc doctor` (check `wiki.judge`) reports the provider, the model, today's <!-- config-path:ignore -->
  calls and failures.
* **Model note.** The gateway's `judge` alias served `openai/gpt-6-sol` when this was measured. That model
  answers HTTP 400 to `temperature` and `max_tokens`, so the judge request sends neither.

**Judge study (public evergreen corpus, same 60 notes and 30/30 split as the calibration).** Pre-registered
before any judge call (hash `97eae3b09719f489ac4e7fe8733580cfa279eb10e07515f2dc2d0ccefa704e45`, judge prompt
and code frozen). Gold labels are not from the judge's family (OpenAI): positives are Gemini-written
rewrites, summaries and topics; negatives were labelled by a Claude model. 1200 judged items, `openai/gpt-6-sol`,
about 2 s per call. Arms: **A** embedding-only at the shipped floor; **B** judge over candidates at the
floor; **C** judge over the top-3 nearest whatever their cosine.

| S1 topic to page (held-out, 31 positives) | precision | recall | F1 |
| --- | --- | --- | --- |
| A, floor 0.708 | no pair flagged | 0.00 | 0.00 |
| B, judge at the floor | no candidate to judge | 0.00 | 0.00 |
| C, judge over top-3 | 1.00 (6/6) | 0.19 (6/31) | 0.32 |

C was perfectly precise (no false `same_topic` in 331 gold-negative items, including topics whose page was
removed), but it found only 12 of 63 pages: the top-3 holds a gold page for 28 of 63 topics, and of the 29
gold candidates the judge saw it answered `overlapping` for 17 on a three-to-eight-word topic. The pre-registered rule for turning
the judge on by default needed a recall lift of 0.25 over embedding-only on the held-out split, and C's was
0.19, so **`wikiJudge.enabled` ships `false`**. B has almost nothing to judge, because the floor passes 5 of 360
candidates. A follow-up could judge the top-3 whatever the floor says, but the study does not support
it yet. For note pairs (`lint_wiki`), the judge over the 840 labelled pairs had precision 0.92 and recall
0.95 (held-out 0.90 / 0.95); 8 of its 10 disagreements with the title-only labels were real duplicates on a
full read by a second model, so the lint judge is on by default once a judge is configured (it only adds a verdict to a proposal), while the `find_existing_page` judge stays off. With 31 held-out positives the
intervals are wide; this is one corpus, one embedding model and one judge model.

**TypeSafe Jev against the gateway judge (note pairs, same corpus and split).** A second pre-registered study
(written and hashed before the first Jev call; one earlier connectivity call and the known `openai/gpt-6-sol`
held-out result are disclosed in it) asked whether Jev (`jev-1.13.0`) is non-inferior to the gateway judge's
recorded verdicts on the 840 labelled `lint_wiki` pairs. Jev's `same_topic` probability threshold was tuned on the
30-note calibration split only, and the 30-note held-out split was scored once. Non-inferiority needed, for
precision and for recall each, a point difference no worse than 0.05 absolute and a one-sided 95% paired-bootstrap
lower bound no worse than -0.10 (10,000 resamples, seed 1328). **Result: Jev was non-inferior at that margin on
both metrics, so Jev is the recommended lint-judge provider on Cave** (`wikiJudge.provider: typesafe`); the gateway
judge remains the default provider. With about 63 held-out positives the power is low, and it is one corpus, one
embedding model and one threshold. TypeSafe's customer agreement bars publishing benchmark figures, so no Jev
precision, recall, latency or threshold is published here: the figures and the tuned threshold stay with the operator
(tune the threshold on labelled pairs from your own vault). The `find_existing_page` judge is unchanged: the
topic-to-page recall that kept it off was measured with the gateway judge and has not been re-measured for Jev.

## Wiki workflow (draft and commit a page)

Two more `full`-profile tools take a wiki page from topic to a linked, schema-checked note. They split
the work so the server does the bookkeeping and **the LLM writes the prose**: neither tool generates
page text.

1. **`find_existing_page`** (above): is there already a page on the topic?
2. **`draft_wiki_page`** (read-only): runs the same duplicate check, then returns the existing page if
   there is one, a **link map** (`link_to`: notes the page should link, `link_from`: notes that should
   link to it, `already_linking`), the SCHEMA.md requirements for the page `type`, and a changeset
   skeleton (a proposed path, frontmatter and a patch per note to link from). It writes nothing.
3. **You write the page body**, using the notes the link map names.
4. **`commit_wiki_page`**: applies the changeset in one step, the new page plus additive patches
   (`link`: a bullet under a heading such as `See also`, added once; `append`: text at the end or under a
   heading) that link the rest of the wiki to it.
5. **`lint_wiki`** (above) is the periodic upkeep: orphans, unresolved links, stale or duplicate pages.

**SCHEMA.md.** Set `vaults[].wiki.folder` (for example `wiki`) and put a `SCHEMA.md` in it. Its
frontmatter declares the page types, the frontmatter each requires, the subfolder new pages of a type go
in, and the allowed property vocabulary (a list of names, or a map of name to allowed values; an empty
value means any). The body is free prose and is never parsed.

```yaml
---
types:
  concept:
    description: An idea or term
    required: [type, summary, sources]
    folder: concepts
  person:
    required: [type, summary]
properties:
  type: [concept, person]
  summary:
  sources:
  status: [draft, stable]
---
```

Obsidian's own `tags`, `aliases` and `cssclasses` are always allowed. SCHEMA.md is read as a bounded
file: one over 64 KiB is not parsed, and a section over 100 types, 100 fields per type, 500 properties,
200 values per property or 200 characters per name or value is cut, each with a warning. A SCHEMA.md
that cannot be read is a `schema_file` problem, never an error.

**The wiki folder is required.** `commit_wiki_page` refuses (`invalid_input`, `reason: no_wiki_folder`)
in a vault with no `wiki.folder`, and refuses a page outside it (`reason: outside_wiki_folder`). The
page path is judged as written (`..` and absolute paths are `path_invalid`) and again after symlinks,
and "inside" means the same directory as the filesystem sees it (the folder's device and inode against
each directory above the page), never a string comparison: `Café` in two Unicode forms and `Wiki` against
`wiki` are one directory on some volumes and two on others, and no spelling can make two different
directories equal. So neither a sibling folder that shares the prefix, a case or Unicode variant nor a
symlink out of the folder can carry a page past the check. While the folder does not exist yet only its
exact configured spelling is accepted. The folder itself must be a plain relative path in the config:
`.`, `/`, an empty string, an absolute path and `..` are rejected, never reinterpreted. A segment
ending in a space or dot is rejected too, because Windows strips those suffixes. The same rule applies
to `wiki.rawFolder`.

**Scopes.** The tool needs `read:notes` as well as `write:notes`: the duplicate check reads every note
the caller may read and names the matches.

### Ingesting a raw source

The wiki is built from sources you collect and do not edit: web clippings, papers, transcripts. Each vault
has a **raw folder**, `vaults[].wiki.rawFolder`. It defaults to `raw` **beside** the wiki folder (`wiki`
gives `raw`, `notes/wiki` gives `notes/raw`) and is not set at all when that would be the wiki folder
itself; it must never be, contain or sit inside the wiki folder (the config refuses it), so a raw note
can never be a wiki page or a `lint_wiki` subject. It is validated like `wiki.folder`.

**The raw folder is immutable.** It is the folder ACL's own rule, built per vault from the config: no
tool writes, creates, renames or deletes anything in it (`acl_denied`), for any caller and whatever the
vault's `writePaths` / `deletePaths` say. Reads follow the normal read ACL. A path counts as raw by its
name and by where it really leads, so a symlink in the wiki that points into `raw/`, or one inside
`raw/` that points out, does not make a source writable. `commit_wiki_page` therefore refuses a page,
an overwrite or a patch that targets it, and refuses the whole commit. Add sources outside the server
(Obsidian, a web clipper, the file system). Raw notes are inputs, so they are never `find_existing_page`
or `draft_wiki_page` candidates and never offered as a `link_from` patch.

**Renames leave raw notes alone.** `move_note`, `bulk_move_notes` and `move_attachment` repoint the
links in every note that links the moved target, but never in a raw note. The move proceeds; each raw
note that links the target is left as it was, so its link now points at the old name. The result says
so: `immutable_not_updated` lists those notes you may read, `immutable_not_updated_hidden` counts the
ones you may not (a count, never a path), and `immutable_warning` explains. Repoint them outside the
server. If `raw` is a symlink to another folder in the vault, that folder is immutable too (from the
next server restart), is raw under its real name everywhere (duplicate checks, `lint_wiki`, the judge:
with `raw -> sources`, `sources/Topic.md` is a source, never an existing page), and the raw folder and
wiki folder must not be the same directory.

**Ingest.** Pass one raw note to `draft_wiki_page` as `source` (a `.md` note inside the raw folder, with
the `topic` of the page it feeds). You get the usual duplicate check, link map and changeset skeleton,
and the server does the bookkeeping:

- the note is cited in the skeleton's `sources` as a property link (`[[raw/Clip]]`) and appears in the
  link map as a `source`;
- `ingest` reports it: `path`, `content_hash`, `chars` (the body, frontmatter excluded), `title`, and
  `cited_by`, the wiki pages that already link it (so you can see it was ingested before);
- you read it with `read_note` and write the prose; the server never calls a model here, apart from the
  optional dedupe judge `find_existing_page` already has, which never sees a raw note.

**A page must compress something.** A source under **1500 characters** is refused a page of its own when
nothing in the wiki can take it in: no page covers the topic, none is related to it and none already
cites it. The answer then has no changeset and `ingest.refused` is `{ reason: "source_too_short", chars,
min_chars }`: wait for more sources on the topic, or add it to a page that exists. With a page that
covers, relates to or cites it, a short source is fine. The rule is advisory advice from the draft step;
the security rules (immutable raw, no raw page) are enforced by `commit_wiki_page` and the ACL.

**A source you may not read never leaks.** A `source` the read ACL denies answers exactly like one that
does not exist (`note_not_found`), before any byte of it is read; a path outside the raw folder is
`invalid_input` (`reason: outside_raw_folder`), judged on the filesystem like the wiki folder (the
folder's device and inode against each directory above the path, as written and after symlinks); a vault
without a raw folder is `invalid_input` (`reason: no_raw_folder`); a raw folder that leaves the vault
or whose identity cannot be established is `invalid_input` (`reason: raw_folder_unsafe`); a non-markdown
file is refused (`reason: not_markdown`). The read check comes first, so a read-denied symlink answers
`note_not_found` like a missing file.

**Problems versus errors.** Things for you to fix do not block the write; they come back in
`problems`: `schema` (missing required field, unknown type or property, value outside the vocabulary),
`unresolved_link`, `missing_link` (a related note the page does not link), `no_inbound_link`,
`patch_without_link`, `patch_skipped` (the note already links the page), `possible_duplicate`,
`excluded_note`, `poison_suspect`, `redacted`. Generated-page work runs after the response and reports
its warnings in the server log rather than this array. Refusals are errors and write nothing: no write
or read permission on any existing note it touches (an unreadable note answers like a missing one and
its hash is never returned), a stale `prev_hash` (every stale note is named in `details.stale`), a page that
already covers the topic (`conflict`, `reason: duplicate_page`, checked again right before the write;
`allow_duplicate: true` overrides), text that fails the poison scan, a heading that is missing or
ambiguous, and two entries naming one filesystem object (existing paths are compared by device and
inode, so symlink aliases collide while two real case-distinct files on a case-sensitive volume do not).
Open contradictions the detector
already flagged on a touched note are listed in `contradictions`; new ones are found by the indexer
afterwards.

**Confirmation.** Per operation, as the single-note tools ask it. Creating a page inside the wiki folder
needs **no confirmation**: every existing note a commit patches or replaces is snapshotted first, so
`restore_note` undoes those. A new page has no prior state, so it has no snapshot and `restore_note`
cannot undo it; remove it with `delete_note` (which asks for confirmation, and moves the page to the
trash). Patching a related note anywhere asks nothing either, as `patch_note` does, under the same ACL (both
read and write permission on the note). Overwriting an existing non-empty page (`page.mode: overwrite`,
which needs `prev_hash`) asks for confirmation exactly like `write_note`. Everything else keeps its
existing rules: `write_note`, `patch_note`, `delete_note` and the rest behave as before.

**All or nothing on errors; not crash-atomic.** Before the first write, `commit_wiki_page` checks the
read and write ACL of every path, the `prev_hash` of every existing note, the poison and memory-defense
scans, and computes every resulting note. It then snapshots every existing note it will replace, stages
a synced temp file for every note, writes one `pending` write-provenance record naming every path and the
hash it is about to hold, and renames the files back to back, re-hashing each existing note immediately
before it is replaced: a note edited since it was read aborts the whole batch and the edit is kept. If a
pending provenance row cannot be recorded, the staged files are discarded and no rename runs. The
settling `ok` record uses the batch's own written hashes, not a disk re-read that could observe a later
concurrent edit. If a
write fails part way, every earlier write is undone, except a note whose content changed since the batch
wrote it, which is left alone and named in `details.changed_since_written`; a page someone else created
is never deleted. Each undo moves the note aside, hashes the moved file and only then drops it or puts
the old text back (with a no-replace create), so it never deletes or overwrites what the batch did not
write; while a note is aside its name is briefly empty, and a note another process writes there in that
gap is kept. When any undo is incomplete (`internal_error`, `details.reason: rollback_incomplete`) the
snapshots taken for the call are kept, so `restore_note` can recover each pre-image; after a clean
rollback they are dropped. Snapshot retention is pruned only after the batch succeeds, and that
cleanup, like reindexing, is best-effort: a fault there (a locked database, say) cannot undo a batch
that has landed, so it is logged and returned as a `post_commit` problem, never as an error. When the
provenance frontmatter stamp is on, the new page is checked against `SCHEMA.md` with the stamp in
it. A process crash (SIGKILL,
power loss) between two renames can leave a partial batch: the `pending` record then has no `ok` or
`error` record after it, which is how the batch is found, and `restore_note` returns each replaced note.
The re-hash narrows the window for an edit by another process to the gap between the hash and the
rename; POSIX has no conditional rename, so it cannot be closed. A successful commit ends with an `ok`
record listing every touched path; an aborted one ends with an `error` record only when the `pending`
record was already written.

### Generated index and log pages

The wiki folder also holds two files the server writes, not you and not an LLM. Both start with
`generated_by: obsidian-tc` in their frontmatter and a notice; do not edit them.

* **`index.md`**: every page of the wiki folder grouped by its `SCHEMA.md` `type` (the schema's order <!-- config-path:ignore -->
  first, then other types, then `(no type)`), one link each. Queued after every `commit_wiki_page` and,
  with `maintenance.wikiPages.enabled: true`, every `maintenance.wikiPages.intervalHours` (default 6). It
  is never maintained by an LLM and is left unchanged when the listing did not change.
* **`log.md`**: an append-only projection of the write provenance chain for the wiki folder, one line per <!-- config-path:ignore -->
  change: `time (UTC) | op | path | principal | model | tool#seq`, for example
  `2026-10-02T09:15:00Z | create | wiki/concepts/Spaced repetition.md | alice | claude-opus | commit_wiki_page#41`. <!-- config-path:ignore -->
  `op` is `create`, `update` or `delete`. The last projected provenance sequence number is stored in
  the file's `last_seq` frontmatter, so a re-run never repeats a line. It lags one write: a commit's own
  line appears the next time the pages are regenerated. `model` is what the client said about itself.
  **Reading it needs `read:provenance` as well as `read:notes`**, the scope `get_provenance` requires for the
  same facts. The server enforces that on the path itself (an implicit per-path rule-scope, added to the
  ACL of every vault with a `wiki.folder`), so `read_note`, the search and listing tools, links, resources
  and `lint_wiki` all refuse or omit `log.md` for a caller without it. The same scope is needed to edit or
  delete the file; the server's own regeneration is not a caller and is not affected. <!-- config-path:ignore -->

Both list only paths a reader holding no rule-scope may read under the vault's ACL (a symlink alias of a
read-denied folder included) and never an Excluded note, so a page in a read-denied folder is not named.
A page name is written with control, format and line-separator characters stripped, so one page is one
line. They are written with no confirmation, inside the
wiki folder only, with a snapshot of what they replace, and a failure is reported as a
server error-log warning, never an error on the already committed write. The queue keeps generation
off the request path because a large vault scan can take seconds.

**A hand-edited page is never overwritten.** A keyed HMAC-SHA-256 in the frontmatter seals each file;
the per-server key is created on first use in a mode-0600 file under the server cache directory, and
the seal also binds the vault id and file path. If the file was edited, or is someone's own `index.md` <!-- config-path:ignore -->
with no marker, the server leaves it as it is, logs the warning,
and `lint_wiki` (check `generated_pages`) proposes the fix: move
your text to a page of its own and delete the file (`restore_note` keeps a copy); the next pass writes a
fresh one. An edit made while a page is being rebuilt is caught too (the file is hashed again right
before it is replaced); like `commit_wiki_page`, this cannot close the gap between that hash and the
rename, because POSIX has no conditional rename. Duplicate-topic detection, `lint_wiki` and the orphan, dangling-link and provenance scans skip
both files, and their links are not counted as inbound links.

The seal key is server state. Pointing the server at a new `cacheDir`, or running another server with
its own cache state, gives it a different key, so existing generated pages read as edited rather than
trusted. Delete the affected `index.md` or `log.md`; the next wiki-page pass regenerates it with that <!-- config-path:ignore -->
server's key.

**One-time migration from the old seal.** A matching legacy unkeyed SHA-256 is recognised only so the
server can replace the file; it is never accepted as authenticated input. The next pass rebuilds the
whole page with the HMAC. For `log.md`, it discards the legacy preamble and `last_seq` and projects from
the provenance database again. An edited or invalid legacy file is left untouched and reported.

## Long-running tools

Some clients give up on a call after about a minute (Codex and ChatGPT around 60 s, the Cloudflare
Agents SDK 60 s), and Claude Code after five minutes without progress. A tool that can outlast that,
today `index_vault` on a large vault, therefore never holds the request open past a time budget of
**40 seconds**:

- **It finishes inside the budget.** The call returns the tool's own result, exactly as if it had run
  inline. This is the common case, so small calls stay synchronous.
- **It does not.** The call returns a normal (non-error) result carrying a handle,
  `{ "status": "working", "task_id": "…", "poll_tool": "get_task_status", "tool": "index_vault", "message": "…" }`.
  The work keeps running on the server. Call `get_task_status` with that `task_id`: while it is
  `working` it reports `progress` (units done, total when known) and a `retry_after_seconds` hint, and
  once `completed` it carries the tool's result under `result` (a failure carries `error`). The text
  block says the same in a sentence, because some clients read nothing else.
- **A client that declared the Tasks extension** gets the handle at once and polls `tasks/get` (HTTP).
  stdio has no `tasks/get` route, so it neither advertises the extension nor hands a task handle to a
  client that declares it: it gets the budgeted wait and `get_task_status` like any other client.
- **A caller that sends a `progressToken`** receives `notifications/progress` while the call runs;
  `index_vault` reports notes processed out of notes seen. Most clients reset their own timeout on each
  one.

Only the caller that started a task can read it with `get_task_status`; a missing, foreign or internal
id all answer `not_found`. The same budget applies when the tool is reached through `call_capability`
or a domain tool.

## Result size and paging

Clients cap how much of a tool result they show the model: Grok Build inlines about 20 KB and
drops `resource_link` blocks, claude.ai keeps about 150,000 characters, and Claude Code saves a
text result over 50,000 characters to a file. So a **list or search tool's default page stays
under 20 KB** on a large vault. It does that by lowering the default item count, never by cutting
a result mid-item, and every one of them says how to get the rest. `governor.maxResponseBytes`
is unchanged: it is the hard ceiling that refuses an oversized response, not a page size.

| Tool | Default page | Next page |
| --- | --- | --- |
| `list_notes`, `list_attachments` | 100 | `next_cursor` |
| `find_notes_by_tag`, `find_notes_by_property`, `get_backlinks`, `find_orphans`, `find_unresolved_links` | 100 | `next_cursor` (an offset; pass it as `cursor` with the same arguments) |
| `search_text`, `search_regex`, `search_jsonlogic`, `search_vault`, `list_tasks` | 25 | `next_cursor` |
| `find_link_cycles` | 10 cycles of at most `max_length` (10) links; `skipped_longer` counts the rest | raise `limit` or `max_length` |
| `vault_graph_search`, `knowledge_search`, `diagnose_retrieval` | `final_top_k` 10 | raise `final_top_k` |
| `list_commands`, `makemd_query`, `query_datacore`, `search_omnisearch`, `knowledge_get_critical`, `list_capture_queue`, `get_session_traces`, `query_base` | 50 to 100 | `cursor` where the tool has one, else a larger `limit` |

Pass `limit` to ask for a bigger or smaller page. The whole-note readers (`read_note`,
`read_notes`, `read_resources`, `read_snapshot`, `fetch`, `search_and_read`, `bundle_files`,
`bundle_folder`, `get_active_file`, `session_bootstrap`) exist to return whole notes, so they are
paged by the byte budget instead, and they advertise
`_meta["anthropic/maxResultSizeChars"]` in `tools/list` so Claude Code keeps their result inline
rather than saving it to a file. The value is `governor.maxResponseBytes`, capped at Claude Code's
own 500,000-character ceiling, and no other tool carries it.

No tool returns a `resource_link` or an embedded resource, and every result carries a text block.
`get_attachment` returns a `description` (type, pixel size for common images, file size, and a
pointer to `ocr_attachment`) beside the base64 `content`; pass `include_content: false` for the
description alone.

## Response format

Tools that return more than an acknowledgement take an optional `response_format`:
`concise` returns only the high-signal fields, `detailed` returns the full payload.
The format is resolved in this order: an explicit `response_format` on the call, then
the legacy `verbosity` alias (`terse` is `concise`, `full` is `detailed`), then the
operator default `tools.defaults.responseFormat`, then `detailed`. The shipped default
is `detailed`, so output is unchanged until a call or the config opts in.

Supported today: `read_note`, `read_notes`, `get_active_file`, `write_note`, `append_note`,
`patch_note`, `update_frontmatter` (and the `update_active_file`, `append_active_file` and
`patch_active_file` tools, which pass the parameter to the tool they delegate to),
`read_frontmatter`, `find_notes_by_property`, `list_notes`, `get_outgoing_links`,
`get_backlinks`, `find_unresolved_links`, `read_resources`, the search tools
(`search_text`, `search_regex`, `search_semantic`, `search_jsonlogic`, `search_vault`) and
`note_quality_report`. A concise write acknowledgement is `{ vault, path, content_hash }`;
a concise `read_note` is the note body without frontmatter (or just the requested section).
Other concise shapes: `read_frontmatter` omits `has_frontmatter` (it is `frontmatter !== null`);
`list_notes` returns `{ vault, notes: [{ path }], next_cursor }`; `get_backlinks` returns
`{ source_path, line }` per backlink; `get_outgoing_links` returns `{ target, line, resolved }`
per link plus `heading`, `target_path` and `candidates` when they are set; `read_resources`
returns `{ ok, uri, text }` per item with the note body only.

`resources/read` takes no parameters, so only the config default applies to it: with
`tools.defaults.responseFormat: "concise"` it returns the note body without its frontmatter
block (the URI and MIME type are kept). The scope, vault binding, folder ACL, size ceiling
(judged on the raw note) and cache hints are the same in both formats. `find_orphans` already
returns bare paths, so it takes no parameter.

The listing, graph, memory and episode tools also take it: `list_attachments`,
`list_periodic_notes`, `list_snapshots`, `list_capture_queue`, `list_goals`, `search_and_read`,
`vault_graph_search`, `knowledge_search`, `get_entity`, `query_entity_graph`,
`get_session_traces`, `session_bootstrap`, `work_episodes`, `work_episode_chain`,
`work_search`, `gap_report`, `rewrite_link` and `prune_hub_links`. Their concise shapes keep
what a caller acts on and drop the rest:

- `list_attachments` returns `{ path }` per file plus `reference_count` when requested (no size,
  mtime, MIME type, folder echoes or `total_returned`); `list_periodic_notes` returns
  `{ date, path }` per item (no period or mtime); `list_snapshots` returns `{ id, op, created_at }`
  per snapshot (no `content_hash`, size or total); `list_goals` returns `{ id, text, status }`
  plus `target_date` and `closed_at` when set.
- `search_and_read` returns `{ path, rank, score, body, content_hash }` per note, without
  frontmatter (note mode) or `chunk_id` (section mode). `size_bytes` and `truncated` appear only on
  a note that was cut to its share, since there they say how much to fetch with `read_note`.
- `vault_graph_search` and `knowledge_search` keep `chunk_id`, `path`, `content`, `rerank_score`,
  `vault` and `changed_since_d` per hit, and drop the retrieval provenance (arm, hop, edge, seed)
  and the `route` and `coverage` blocks. `vault_graph_search` also keeps `mode_used`,
  `failed_variants` and `failed_vaults`.
- `get_entity` and `query_entity_graph` return each observation as `{ text, key }`, plus
  `valid_to` and `superseded_by` when the fact is no longer current; they omit `valid_from`,
  `created_at`, `updated_at`, `as_of`, the hop-by-hop `path` and a null `vault_path`.
- `list_capture_queue` omits null and empty item fields; `get_session_traces` drops `args_hash` and
  `caller`; `session_bootstrap` drops each loaded note's parsed frontmatter (the note text in
  `content` is whole).
- `work_episodes`, `work_episode_chain` and `work_search` keep id, time, session, tool, status,
  error code, summary, `trust`, `eligibility`, a true `blocked` and the amendment link, and drop
  vault, caller, channel, episode type, duration, result size and every null or empty field.
  `gap_report` keeps `{ id, query, top_score, gap }` per query (no `results` or `nearest`) and the
  totals.
- `rewrite_link` and `prune_hub_links` on a real run return the counts (`notes_changed`,
  `links_rewritten`, `removed_count`) and `content_hash` without the per-note change list,
  `removed[]` and `prev_hash`. A dry run keeps them, because they are the preview and the inputs
  of the confirming call.

The knowledge-read, link-health, bundle and canvas-reader tools also take it: `vault_context`,
`explain_answer`, `diagnose_retrieval`, `knowledge_get_critical`, `audit_provenance`,
`vault_health_score`, `suggest_links`, `suggest_tags`, `bundle_files`, `bundle_folder` and
`read_canvas` (and `get_provenance`, which drops the host, the full path list, the record hash and
the machine field).

- `vault_context` keeps the packed notes with `{ chunk_id, content, score }` per chunk, the
  syntheses, the open contradictions, the lessons as `{ chunk_id, path, excerpt }`, the episodes,
  `diff_since` and the prefetch pair; it drops the route signals, the query source, the budget and
  stats blocks, and each chunk's `source` and `hop`.
- `explain_answer` keeps each link's chunk, path, whether the chunk still resolves, the citation
  verdict and score and the correlation, plus `caveat` and `citation_pass` (they stop an unjudged
  chain reading as an unused one); it drops `summary` and each link's retrieval echo.
  `diagnose_retrieval` returns `{ vault, returned, dropped_at, summary }`.
  `knowledge_get_critical` returns `{ path, title, category, source }` per document.
- `audit_provenance` drops the `field` echo, `with_provenance` and the `by_folder` breakdown;
  `vault_health_score` drops `total_links` and the per-penalty `breakdown`; `suggest_links`
  returns `{ path, score }` per suggestion; `suggest_tags` returns `source` and the suggestions.
- `bundle_files` and `bundle_folder` keep the bundle text, `file_count`, `truncated` and (per
  tool) the resume `cursor` or `missing_paths`; they drop the per-file list (each path already
  heads its block in the bundle), `total_bytes` and the `root` echo. `read_canvas` keeps what a
  node says and what an edge joins, and drops the layout (geometry, background, edge sides and
  ends) and the two counts.

Ten more reads and reports take it: `find_notes_by_tag`, `get_note_tags`, `read_property`,
`get_periodic_note`, `find_or_create_periodic_note`, `index_vault`, `inspect_visibility`,
`get_server_config`, `bulk_create_notes` and `bulk_set_property`.

- `find_notes_by_tag` returns `{ path }` per match plus `truncated` (it says the list is cut), and
  drops the matched tags and `total`; `get_note_tags` returns only the combined `all` set, not the
  frontmatter and inline split; `read_property` returns `value` and `found` without the `key` and
  `nested` echoes.
- `get_periodic_note` and `find_or_create_periodic_note` keep the date, path, `exists` or
  `created`, the note `content` and any `redactions`, and drop the `period` echo and the parsed
  `frontmatter` (the content already carries the block).
- `index_vault` keeps the note and chunk totals and every failure, skip and degradation signal
  (`secrets_skipped`, `notes_embed_failed`, `chunks_dedup_unresolved`, `embed_batch_rejections`,
  `notes_stale_skipped`, `notes_epoch_stale_skipped`, `notes_frontmatter_failed` with its list, `vec_enabled`, `fts_enabled`),
  and drops the bookkeeping counters (unchanged chunks, edge and upsert/delete totals, reused
  dedup chunks, model, dimensions).
- `inspect_visibility` returns `{ name, visibility, reason }` per tool, plus `matched_tag` and
  `missing_scopes` when the verdict has one (the rule that decided it); it drops `domain`,
  `required_scopes` and `tags`. The `summary` still covers the whole surface.
  `get_server_config` keeps the auth mode, `read_only`, the embeddings provider, the limits, the
  limiter backend and failure policy, the governor ceiling and the detected plugins, and drops the
  per-class throttle tiers, the observability toggles and the retrieval-defaults report.
- `bulk_create_notes` and `bulk_set_property` keep `succeeded`, `failed` and every per-item
  outcome (path, `ok`, hash, `prev_value`, `redactions`, error), and drop `processed`,
  `duration_ms` and each created item's `mode_used`.

Concise never drops a safety signal: a non-empty `quality_warning`, a `poison_assessment`
other than `none` (`list_capture_queue` always keeps it), `redactions`, a redacted `to_target`
echo from `rewrite_link`, the trust and eligibility of a work episode, and a `patch_note` call's
removed-line and removed-byte counts are kept, and errors are never shaped. Because `concise`
omits fields, the advertised output schema marks those fields optional; a `detailed` result
always carries them.

### Tools with no `response_format`

Each of these was reviewed and takes no parameter, because there is nothing a caller could spare:

| Tool | Why |
| --- | --- |
| `list_tags`, `list_properties` | One `{ name, count }`-style row per entry: already minimal. |
| `search`, `fetch` | The shape is fixed by the connector contract that ChatGPT deep research and company knowledge read: `{ results: [{ id, title, url, text }] }` and `{ id, title, text, url, metadata }`. The full note text is the payload. |
| `list_vaults`, `list_kanban_boards` | One minimal row per entry. |
| `list_workspaces` | Workspace names only. |
| `list_bookmarks` | The item tree and the compare-and-swap `content_hash` are the payload. |
| `list_commands`, `list_quickadd_actions`, `list_templates` | Opaque plugin passthrough: `{ id, name }`, `{ name, type }` or `{ path, name }` per entry. |
| `list_tasks` | Every field is task data, and empty optional fields are already omitted. |
| `list_contradictions` | The rationale is the product. |
| `episode_stats` | Aggregate counts only. |
| `find_orphans` | Bare paths already. |
| `commit_wiki_page` | A short receipt of the writes plus the problems found: every field is a safety signal. |
| `plur_get`, `plur_recall`, `plur_recall_hybrid`, `plur_similarity_search` | Read-only proxies of an external payload this server does not own. |
| `reflect`, `knowledge_challenge` | The synthesized answer or verdict and its evidence are the product; the rest is a few short fields. |
| `find_link_cycles`, `graph_centrality`, `graph_path_between` | The path lists, ranked rows or hop chain are the payload; the rest is a count or a presence flag. |
| `get_link_strength` | One scored row: every field is a component of the score. |
| `graph_communities` | The communities are the payload; `modularity`, `meaningful` and the chance warning are safety signals. |
| `git_status`, `git_diff`, `git_log`, `git_stage`, `git_commit` | Opaque Obsidian Git companion passthrough or acknowledgement. `git_commit` also returns any `stamped_trailers`, which are provenance a caller must see. |
| `ocr_attachment`, `ocr_bulk` | Opaque Text Extractor passthrough: the extracted text is the payload. |
| `read_base`, `query_base`, `read_kanban_board`, `query_canvas` | The parsed document, resolved rows, columns and cards or matching nodes are the payload; `content_hash` is the compare-and-swap token. |
| `create_base`, `update_base`, `create_canvas`, `update_canvas`, `add_kanban_card`, `move_kanban_card` | Write acknowledgements: counts, any deprecation notice and the compare-and-swap hashes the next write needs. |
| `read_excalidraw`, `create_excalidraw`, `update_excalidraw` | `read_excalidraw` already selects its payload with `format`; the rest is opaque Excalidraw companion JSON or an acknowledgement. |
| `format_table`, `insert_table_column`, `insert_table_row`, `sort_table_by_column` | Write acknowledgements: row and column counts, the compare-and-swap hashes and the `redactions` signal. |
| `eval_dataview_field`, `validate_dql`, `search_dql`, `query_datacore` | Opaque Dataview or Datacore companion passthrough: the value, AST, rows or parse-error location is the payload (`search_dql` also returns `note_paths`, which index the matched notes). |
| `makemd_list_spaces`, `makemd_query`, `search_omnisearch` | Opaque MakeMD or Omnisearch companion passthrough: the items or hits are the payload. |
| `remotely_save_status`, `remotely_save_trigger` | Opaque Remotely Save companion passthrough or acknowledgement. |
| `create_entity`, `add_observation`, `update_observation`, `link_entities`, `unlink_entities`, `rename_entity`, `delete_entity` | Write acknowledgements: entity and observation ids, status, the edge identity, counts (observations, relations removed, neighbours re-materialized), timestamps and the `redactions` signal. |
| `start_session`, `end_session`, `enqueue_capture`, `commit_capture` | Write acknowledgements: ids, paths, event count and duration, the compare-and-swap hash and the `redactions` signal. |
| `set_goal`, `close_goal`, `record_retrieval_feedback`, `work_result`, `work_forget` | Write acknowledgements: ids, the new state and how many retrievals were stamped, demoted or forgotten (`updated: 0` carries a `reason`). |
| `session_rerun` | The per-record verdicts and divergences are the report; the summary counts qualify them. |
| `add_tag`, `remove_tag` | Write acknowledgements: the removed count and the compare-and-swap hashes the next write needs. |
| `copy_note`, `move_note`, `delete_note`, `delete_active_file`, `restore_note`, `snapshot_note` | Write acknowledgements: the destination or snapshot id, the content hashes, where a deleted or overwritten file was trashed, `backlinks_updated` (a blast-radius count) and the `redactions` signal. |
| `bulk_move_notes` | Every per-move row is a blast-radius count or an error, and `hidden_backlinks` is a safety flag. |
| `note_exists` | One boolean and a type. |
| `read_snapshot` | The stored content is the payload; the rest is four short scalars. |
| `read_metadata_fields`, `tasks_filter`, `resolve_daily_note` | Opaque companion passthrough: the fields, the matched tasks (ACL-filtered here) or the resolved path is the payload. |
| `execute_command`, `execute_template`, `trigger_quickadd`, `show_file_in_obsidian` | Opaque companion passthrough or acknowledgement: the plugin's own result, whose effects this server cannot see. `execute_template` also returns any `stamped_trailers`, which are provenance a caller must see. |
| `get_attachment` | The base64 bytes are the payload; MIME type, size and encoding describe them. |
| `write_attachment`, `move_attachment`, `delete_attachment` | Write acknowledgements: the path, size and hash, where a replaced or deleted file was trashed, `references_updated` (a blast-radius count) and, for a delete, the notes that still reference it. |
| `add_bookmark`, `remove_bookmark`, `open_workspace`, `save_workspace` | Write acknowledgements, or the layout itself for `open_workspace`: counts and the compare-and-swap hash the next write needs. |
| `create_periodic_note`, `append_to_periodic_note` | Write acknowledgements: the path, the bytes appended, whether the template expanded and the `redactions` signal. |
| `update_task` | Write acknowledgement: the before and after task state, the compare-and-swap hash and the `redactions` signal. |
| `generate_uri` | One URI. |
| `add_vault`, `reload_vault`, `reset_vault_cache`, `refresh_plugin_capabilities` | Acknowledgements: the vault id and times, the rows dropped (the blast radius) or the capability diff, which is the payload. |
| `get_vault` | One vault's configuration; `read_only` and the ACL path lists are safety signals and the rest is two short blocks. |
| `get_index_status`, `get_task_status`, `server_health` | Every field is a health signal (reconcile state, write failures, vec and fts, the job queue, leader role, facade and telemetry; for `get_task_status`, the state, progress and retry hint of one task, with the finished tool's own result under `result`). |
| `get_metrics`, `inspect_acl` | The metric rows, or the one allow or deny verdict with its rule, are the payload. |

Every registered tool is in exactly one of the two groups, the tools that take `response_format`
and the table above. A test fails when a newly registered tool is in neither, so the decision
cannot be skipped.

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
