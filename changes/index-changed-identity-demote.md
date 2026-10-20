---
type: Fixed
---
- **`index_vault` demotes a note whose ACL identity changed before it reads the note.** A folder pin retargeted between passes used to leave the note's stored identity in place until the pass finished, so a pass that ended early kept authorizing the old identity. The stored row now becomes unresolved (fail closed) as soon as the walk sees the new identity, and it takes the new identity only together with content read from the new file and committed in the same pass. A note the pass could not read, or whose new content never committed (an embedding failure or a cancelled pass), stays unresolved, so its old content is never shown under the new identity.
