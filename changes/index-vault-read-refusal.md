---
type: Fixed
---
- **`index_vault` no longer aborts on a note the safe open refuses.** Indexing a folder that is an unconfigured symlink (or a note that became hard-linked mid-pass) used to fail the whole pass with `acl_denied`; each refused note is now skipped and left unresolved in the index, counted in the new `notes_read_refused` result field, and listed in `read_refusals` where the caller may read that path.
