---
type: Security
---
- **A SCHEMA.md read error no longer shows the vault's absolute path.** A SCHEMA.md that could not be
  read (permissions, a race with a deletion) reported the OS error message, which carried the server's
  absolute file path. The warning now names only the error code, such as `EACCES`, so
  `draft_wiki_page` reports `wiki/SCHEMA.md could not be read: EACCES`. Callers that matched the old
  message text need to match the new one.
