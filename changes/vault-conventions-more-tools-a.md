---
type: Added
---
- **More note writers report folder convention warnings.** `add_tag`, `remove_tag`, `update_frontmatter`, `restore_note`, `format_table`, `insert_table_row`, `insert_table_column`, `sort_table_by_column`, `update_task`, `create_periodic_note`, `append_to_periodic_note` and `find_or_create_periodic_note` now check the note they wrote against the `conventions:` rules in the folder's `SCHEMA.md` files, as `write_note` does. A write that breaks a rule carries `conventions.warnings` naming the note, and the write still succeeds. A call that changes no note adds no `conventions` key. `rewrite_link` is not checked: it rewrites links across the vault and judges no single note.
