---
title: Memory you own
description: What a memory entity actually is on disk, which ACL/audit pipeline writes it, how git provenance works, how to recall it (with and without semantic search), and a session-bootstrap recipe for reading and writing it back across sessions.
---

obsidian-tc's memory graph is not a vendor-hosted "memory feature" — it is **plain Markdown files in
your vault**, versioned by whatever git history your vault already has, queryable with the same
tools that read any other note. This page shows the actual on-disk shape (generated from a real
`create_entity` + `add_observation` + `link_entities` run, pasted verbatim, not invented), names
the real modules every write goes through, and gives a copy-pasteable recipe for reading a small
index at session start and writing back at session close.

## What an entity, an observation, and a relation are on disk

A **memory entity** (`packages/server/src/memory/entities.ts`) is one row in the
`memory_entities` table (SQLite, the source of truth) plus, when `materialize: true` (the
default), a regenerable `.md` projection under the vault's memory folder — so its `[[links]]`
resolve in Obsidian's own graph view. An **observation** is one fact, stored newline-delimited on
that row (`serializeObservations`/`parseObservations`) and rendered as one bullet. A **relation**
is a typed, directed edge in `memory_relations`, rendered as a `[[wikilink]]` under `## Related` on
the *source* entity's note.

The shape below is a real note, produced by running `create_entity` (with an initial
observation), `add_observation`, and `link_entities` against a scratch copy of
[`examples/scratch-vault`](https://github.com/The-40-Thieves/obsidian-tc/tree/main/examples/scratch-vault)
and then reading the file back off disk:

```md
---
obsidian_tc_id: ent_72d95a75a7a5c176ece73b07
entity_type: note
status: active
imported_from: basic-memory
source_path: notes/coffee-brewing.md
imported_at: 2026-09-25T05:22:47.231Z
---
# Coffee Brewing Methods

## Observations

- [method] Pour over provides more flavor clarity than French press
- [technique] Water temperature at 205F extracts optimal compounds #brewing

## Related

- relates_to [[Tea Brewing Methods]]
```

`obsidian_tc_id`/`entity_type`/`status` are the ONLY frontmatter keys the projection owns
(`packages/server/src/memory/materialize.ts`'s `OWNED_FM_KEYS`) — every other key, including the
`imported_from`/`source_path`/`imported_at` provenance keys above, is **preserved verbatim** across
every future re-materialization (another `add_observation`, another `link_entities`). That is how
`obsidian-tc memory import` (below) can layer provenance onto a note without a special-cased write
path of its own — it merges frontmatter through the same `update_frontmatter` tool an MCP client
would call, and materialize.ts's ordinary round-trip discipline keeps it.

## The ACL/audit pipeline these writes go through

Every one of those writes — `create_entity`, `add_observation`, `link_entities`, and
`update_frontmatter` — is a normal MCP tool (`packages/server/src/tools/m5/memory-tools.ts`,
`packages/server/src/tools/m1/frontmatter-tools.ts`), dispatched through
`ToolRegistry.dispatch` (`packages/server/src/mcp/registry.ts`). That single call site is where:

- the caller's **scope** is checked (`write:memory` / `write:notes`) against the granted set;
- the **folder ACL** is enforced (`packages/server/src/vault/acl-path.ts`'s `enforcePathAcl`) —
  pre-checked BEFORE the SQLite insert, so a denied materialization leaves no orphan row;
- an **`audit_events` row** is written (`recordOutcome`, inside `dispatch`) — caller, tool name,
  duration, result size, status, an args hash; never the raw content.

There is no separate "memory write" code path that skips this. The CLI importer described below
builds its own `ToolRegistry`, registers the real M1 (notes/frontmatter) and M5 (memory) tools, and
calls `registry.dispatch(...)` for every entity/observation/relation/frontmatter write — the exact
call an MCP client makes, ACL-checked and audited the same way, with **no direct file write at
all**.

## Git provenance

obsidian-tc does not auto-commit. Materialized memory notes are ordinary files in your vault, so
"who wrote this and when" is answered the same way it is for any other note:

- **Plain `git log -p -- memory/note/…`** on the vault repo, if you keep it under git — every
  materialization is a normal file write (`writeNoteAtomic`), so it shows up in `git status`/`git
  diff` like anything else you'd stage and commit yourself.
- The **Obsidian Git companion bridge** (`git_status`/`git_diff`/`git_log`/`git_commit`,
  `packages/server/src/tools/m4/git-tools.ts`) lets an agent drive that same repo through the ACL/
  audit pipeline above — `git_commit` requires `execute:git`, a hardcoded human-confirmation floor,
  so an agent can stage and *propose* a commit but never lands one without you approving it.
- If your vault's Obsidian Git plugin has its own autosave/auto-commit interval configured, that is
  the plugin's own author/timestamp policy, independent of obsidian-tc.

Either way, the provenance frontmatter above (`source_path`, `imported_at`) already answers "where
did this come from" without needing git at all — git only adds "and when did it change since."

## Recall: with and without semantic search

**Without semantic search** — plain full-text, no embeddings provider needed. Real output,
`search_text` over the same scratch vault:

```json
{
  "vault": "main",
  "mode_used": "text",
  "items": [
    {
      "path": "memory/note/Coffee Brewing Methods.md",
      "score": 3.1793160834963974,
      "line": 13,
      "col": 56,
      "snippet": "- [method] Pour over provides more flavor clarity than French press"
    }
  ],
  "total": 1
}
```

**Graph recall** — walk the `[[link]]` graph from a known entity, also no embeddings needed. Real
output, `query_entity_graph` seeded on the entity above:

```json
{
  "vault": "main",
  "seed_entity_id": "ent_72d95a75a7a5c176ece73b07",
  "items": [
    {
      "entity_id": "ent_791ed1d7a083f6cd98476c0d",
      "type": "note",
      "name": "Tea Brewing Methods",
      "status": "active",
      "distance": 1,
      "path": [{ "via_entity_id": "ent_72d95a75a7a5c176ece73b07", "via_relation": "relates_to" }]
    }
  ],
  "next_cursor": null,
  "total_returned": 1
}
```

**With semantic search** — `search_semantic` embeds the query and ranks chunks by vector
similarity over the same indexed notes (including materialized memory notes, which are indexed
like any other vault content). It needs a configured embeddings provider (see
[Configuration](/configuration/config-reference/)); this page does not fabricate a transcript for
a provider it did not actually call — see [MCP client compatibility](/getting-started/mcp-clients/)
for this project's own policy on measured-only rows. The practical difference from the two recall
paths above: full-text and graph recall find what you named or linked; semantic recall also finds
what you *meant* — a query for "hot drink technique" would rank the coffee note above without the
word "coffee" ever appearing in it, something neither `search_text` nor a graph walk from an
unrelated seed can do.

## Opt-in: `episode_stats` — memory tools in your own top activity

`episode_stats` (`read:workspace`) aggregates the experiential episode log into counts only —
never episode content — so you can see activity patterns without the fuller `admin:workspace` read
access `work_search`/`work_episodes` require. Real output, `group_by: "tool"`, after a short mixed
session of `create_entity`/`get_entity`/`add_observation`/`link_entities`/`query_entity_graph`
calls against the same scratch vault (`min_bucket: 2` — buckets smaller than that are withheld
into `suppressed`, a k-anonymity floor, not a redaction of these results):

```json
{
  "available": true,
  "group_by": "tool",
  "min_bucket": 2,
  "buckets": [
    { "key": "get_entity", "count": 2 },
    { "key": "create_entity", "count": 2 }
  ],
  "suppressed": 3,
  "suppressed_buckets": 3,
  "total": 7
}
```

Memory tools (`create_entity`, `get_entity`) sit at the top because this was a memory-heavy
session; run it on your own deployment after ordinary use and it reflects what YOUR agent actually
spends its calls on.

## Importing memory you already have

`obsidian-tc memory import` brings notes from two other memory formats into this graph, through the
exact write path above — dry-run by default, `--apply` to write:

```
obsidian-tc memory import --from basic-memory <dir> --vault <id> [--apply]
obsidian-tc memory import --from claude-code-memory <dir> --vault <id> [--apply]
```

| source | one entity per… | name / type from | observations from | relations from |
|---|---|---|---|---|
| `basic-memory` | note | frontmatter `title` / `type` | `## Observations` bullets (`- [category] text`) | `## Relations` bullets (`- relation_type [[Target]]`) |
| `claude-code-memory` | fact file (the index file is skipped) | frontmatter `name` / `metadata.type` | the whole body, as one observation | every `[[link]]` in the body, as a `relates_to` relation |

Every imported note carries `imported_from`/`source_path`/`imported_at` provenance frontmatter
(merged on, per the round-trip discipline above), and a re-run of `--apply` on the same directory
is idempotent — it is keyed on `source_path`, not merely on name, so an entity that already exists
with a **different** `source_path` is refused as a collision rather than silently adopted (the
same "a path that can overwrite data must be at least as strict as the path that wrote it"
discipline the vault's own delete paths follow). Files are refused, with a reason, if they are
symlinked or if their resolved path escapes the import directory — the same containment guarantee
(`resolveVaultPathChecked`, `packages/server/src/vault/paths.ts`) every vault-relative path write
already uses.

Real dry-run output against the `basic-memory` fixture above (one note references a target that
does not exist in the batch, and one file has deliberately malformed frontmatter):

```
obsidian-tc memory import --from basic-memory: DRY RUN (nothing was written; pass --apply to write)

Entities:
action  type  name                    source_path                    observations
------  ----  ----------------------  -----------------------------  -----------------
create  note  Coffee Brewing Methods  notes/coffee-brewing.md        +2 observation(s)
create  note  plain-no-frontmatter    notes/plain-no-frontmatter.md  +1 observation(s)
create  note  Tea Brewing Methods     notes/tea-brewing.md           +1 observation(s)

Relations:
source                  relation_type   target                     status   reason
----------------------  --------------  -------------------------  -------  ----------------------------------------------------
Coffee Brewing Methods  relates_to      Tea Brewing Methods        planned
Coffee Brewing Methods  requires        Proper Grinding Technique  skipped  relation target not found: Proper Grinding Technique
Tea Brewing Methods     contrasts_with  Coffee Brewing Methods     planned

Summary: 3 entity(ies) to create, 0 already present, 0 collision(s), 0 error(s); 4 observation(s) to add, 0 already present; 2 relation(s) to create, 0 already present, 1 skipped

Skipped files:
source_path         reason
------------------  -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
notes/malformed.md  malformed frontmatter: frontmatter is not valid YAML in "notes/malformed.md": Flow sequence in block collection must be sufficiently indented and end with a ] at line 2, column 1:
```

Re-running with `--apply` a second time reports the same set as already present, not duplicated:

```
Entities:
action  type  name                    source_path                    observations
------  ----  ----------------------  -----------------------------  -------------------------
exists  note  Coffee Brewing Methods  notes/coffee-brewing.md        +0 new, 2 already present
exists  note  plain-no-frontmatter    notes/plain-no-frontmatter.md  +0 new, 1 already present
exists  note  Tea Brewing Methods     notes/tea-brewing.md           +0 new, 1 already present

Summary: 0 entity(ies) to create, 3 already present, 0 collision(s), 0 error(s); 0 observation(s) to add, 4 already present; 0 relation(s) to create, 2 already present, 1 skipped
```

## Session-bootstrap recipe

The pattern above generalizes into an ordinary session workflow: **at session start, read a small
index note; load only the domain block the current task needs; write back at session close.** It
needs no obsidian-tc feature beyond the tools already covered on this page —
`search_text`/`query_entity_graph`/`get_entity` to read, `create_entity`/`add_observation`/
`link_entities` to write back. Keep the index small on purpose: it is a table of contents, not the
memory itself, so loading it never costs more than a few tool calls regardless of how large the
graph underneath grows.

```
# Session-bootstrap prompt template

At the start of this session:
1. Read the memory index note for this vault (search_text for its known title, or
   get_entity by a well-known name/type — whatever this vault uses as its index).
   Keep this to ONE read: the index lists domains and their entities, not their content.
2. From the task you were given, identify which domain(s) it touches.
3. Load ONLY those domains: query_entity_graph seeded on each relevant entity (depth 1-2),
   or get_entity for anything the index named directly. Do not load every domain "just in
   case" — that defeats the point of having an index.
4. Proceed with the task using what you loaded, plus ordinary vault search
   (search_text/search_semantic) for anything the index did not anticipate.

At the close of this session, if the session produced a decision, a correction, or a fact
worth keeping:
1. For a NEW fact: create_entity (type + name that fits this vault's existing taxonomy —
   check the index first so you do not invent a near-duplicate type) with materialize: true.
2. For an EXISTING entity: add_observation with one fact per call — do not pack multiple
   facts into one observation string; it is rendered as one bullet.
3. If the new fact relates to something else already in the graph: link_entities with a
   relation_type that describes the relationship in one or two words (matching the vocabulary
   the index/vault already uses, not inventing a new one per session).
4. Do NOT write back speculative or unconfirmed information — this index is read at the
   START of every future session, and a wrong entry costs every session after this one,
   not just this one.
```

This is deliberately generic — no vault-specific paths, domain names, or entity types. Fill in step
1's "known title" / "well-known name" with whatever your own vault's index note is actually called;
everything else composes with `vault_context` (which already does an automatic, TTL-cached version
of steps 1-3 for the common case) or `reflect` (for a grounded synthesis instead of a raw walk) if
your deployment has them wired.

## Watch it work: two sessions

![obsidian-tc memory: session one imports and writes an entity, session two starts fresh and recalls it via search, graph, and a direct read](/demo/memory-two-sessions-storyboard.svg)

A static storyboard for now — `docs/demo/memory-two-sessions.tape` renders the animated version
(`docs/public/demo/memory-two-sessions.gif`) once `vhs` is on your PATH. Every panel above was
captured from the real commands on this page, run against a scratch copy of
[`examples/scratch-vault`](https://github.com/The-40-Thieves/obsidian-tc/tree/main/examples/scratch-vault),
not invented.
