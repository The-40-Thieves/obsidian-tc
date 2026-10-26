---
type: Fixed
---
- **Memory rename and delete are atomic against the vault.** `rename_entity` restores the target and neighbour notes when a step fails, and removes the old note only after the rename commits, so a refused or failed rename no longer leaves a half-moved note. A cascade `delete_entity` refuses a read-only neighbour before any change. A rename whose new name maps to the same note file no longer deletes that file, and a rename whose old note cannot be removed still reindexes the notes it rewrote. A failed cascade `delete_entity` restores the neighbour notes it had rewritten. A permanent `delete_entity` keeps a snapshot of the note, so `restore_note` can bring it back when snapshots are enabled.
