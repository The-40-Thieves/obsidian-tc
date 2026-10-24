---
type: Added
---
- **Note writes report folder convention warnings.** `write_note`, `append_note`, `patch_note`, `move_note` and `copy_note` now check the notes they wrote against the `conventions:` rules in the folder's `SCHEMA.md` files. A result that breaks a rule carries `conventions.warnings` (for example a missing required property) and the write still succeeds: the warnings are advisory, and a note that is clean adds no `conventions` key. Only the rules the caller may read apply. This is the first slice of folder conventions; other write tools report them in a later release.
