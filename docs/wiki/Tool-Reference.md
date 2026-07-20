<!-- TEMPLATE / BLUEPRINT — Tool (API) Reference.
     The catalog between the GENERATED markers is produced from the tool registry by docgen (THE-472);
     do not hand-edit it. Prose outside the markers is hand-authored. -->

# Tool Reference

The MCP tools obsidian-tc exposes to agents. Each tool has a name, an input schema (Zod → JSON Schema), required scopes, and a structured result.

> [!NOTE]
> The catalog below is **generated from the tool registry** — it is always in sync with the running server. To regenerate: `< bun run docgen >`.

## Conventions

- **Scopes** — every tool declares `requiredScopes`; the caller's token/ACL must grant them.
- **Idempotency** — mutating tools accept an `idempotency_key` for safe retries.
- **Errors** — failures return a typed error (`{ code, message }`); see **[Error Codes](Error-Codes)**.

## Tool groups

| Group | Purpose |
|---|---|
| Read | `read_note`, `read_notes`, `list_notes`, `note_exists` |
| Write / Edit | `write_note`, `patch_note`, `append_note`, `update_frontmatter`, `delete_note`, `move_note` |
| Search | `search_vault`, `search_dql`, semantic / BM25 / graph modes |
| Index | `index_vault`, `add_vault`, `server_health` |
| Table / structured | `insert_table_row`, `insert_table_column` |

> [!TIP]
> `patch_note` does **atomic, anchored** edits — append/prepend/replace relative to a **heading section** or a **`^block-id`**, not just whole-file writes. This is how an agent surgically updates a note without rewriting it.

<!-- BEGIN GENERATED: tools -->
<!--
  docgen renders one section per tool here, e.g.:

  ### `patch_note`
  Insert or replace content anchored to a heading section, a block reference, or the frontmatter.
  **Scopes:** `write:notes`  ·  **Destructive:** no  ·  **Idempotent:** yes

  **Input**
  | field | type | required | description |
  |---|---|---|---|
  | vault | string | yes | target vault id |
  | path  | string | yes | note path |
  | operation | "append" \| "prepend" \| "replace" | yes | … |
  | anchor | { heading?: string; block?: string } | yes | … |
  | content | string | yes | … |

  **Result** `{ ok, content_hash, mode_used }`
-->
_(Generated tool catalog appears here once docgen — THE-472 — is wired.)_
<!-- END GENERATED: tools -->

## See also

- [Reading & Writing Notes](Reading-and-Writing-Notes) — task-oriented guide
- [Search: Vector, BM25 & Graph](Search) — retrieval modes explained
- [Configuration Reference](Configuration-Reference)
