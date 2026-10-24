---
type: Added
---
- **Folder conventions warnings on more write tools.** `bulk_create_notes`, `bulk_set_property`, `bulk_move_notes` (reported at the destination), `commit_capture`, `execute_template` and `commit_wiki_page` now check each note they write against the `SCHEMA.md` rules of its folder and return a `conventions` field when a written note breaks one. The write still stands; the warning is advisory. Clients that parse these results can ignore the new field.
