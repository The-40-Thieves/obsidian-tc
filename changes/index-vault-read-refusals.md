---
type: Fixed
---
- **`index_vault` no longer names a note the caller cannot read in `read_refusals`.** A refused read is listed only when `read_note` would read that path for the caller, and its error text carries no host path. `notes_read_refused` still counts every refusal.
