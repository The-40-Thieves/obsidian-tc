---
type: Fixed
---
- **Attachment, search and jsonlogic walks skip a note the safe open refuses.** A note that is a hard link to a file outside the vault, or sits under an unconfigured symlinked folder, no longer fails list_attachments, get_attachment, delete_attachment, search_text, search_regex, search_jsonlogic or search_vault. The walk skips that note and reports `notes_read_refused` (a count, absent when nothing was refused). The refused note is never named. `delete_attachment` with `permanent: true` refuses (`conflict`, nothing deleted) when a read was refused, since a note it cannot read may still embed the file; trash delete is unchanged.
