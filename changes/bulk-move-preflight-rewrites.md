---
type: Fixed
---
- **`bulk_move_notes` checks every backlink rewrite before it trashes anything.** A rewrite the folder conventions gate refuses now refuses the whole batch before any destination is moved aside or any note is snapshotted, instead of after. Nothing is left in `.trash` and no note changes.
