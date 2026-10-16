---
type: Security
---
- **`query_datacore` returns frontmatter links as link objects resolved to their note.** A Datacore link now comes back as `{ path, type, display, subpath, embed }` naming the note it resolves to, so the read ACL drops a row that links to a note the caller cannot read.
