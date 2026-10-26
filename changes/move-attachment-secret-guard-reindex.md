---
type: Fixed
---
- **`move_attachment` refuses a secret-shaped destination path.** The destination is checked the same way `move_note` and `write_attachment` check it, so a secret-shaped name is refused with `secret_detected` in every memory-defense mode, with or without `update_references`. Referencing notes rewritten by a move are now reindexed, so search reflects the new link text.
