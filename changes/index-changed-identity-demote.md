---
type: Fixed
---
- **`index_vault` demotes a note whose ACL identity changed before it reads the note.** A folder pin retargeted between passes used to leave the note's stored identity in place until the pass finished, so a pass that ended early kept authorizing the old identity. The stored row now becomes unresolved (fail closed) as soon as the walk sees the new identity, and it is resolved again only when a later pass completes.
