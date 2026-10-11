---
type: Added
---
- **Per-vault `memory.supersededInNote`.** Set `false` to keep a memory entity's corrected or retired facts out of its materialized note. The note then lists current facts only, so full-text and semantic search stop returning the old text, while `get_entity` with `as_of` still returns the history. The default `true` leaves today's note unchanged. A note already on disk is rewritten the next time its entity is written.
