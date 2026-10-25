---
type: Security
---
- **move_note, bulk_move_notes and move_attachment now require read access to the source.** A move carries the source's bytes to the destination, so the caller must be able to read the source (the read ACL and the `read:notes` or `read:attachments` scope), as `copy_note` already requires. A caller that may only delete and write can no longer move a note or attachment it cannot read into a folder it can read. `move_attachment` also refuses any path that is not a binary attachment as its source or destination (a note, a script such as `view.js`, an Excalidraw drawing, or a name with trailing dots that Windows reads as one of those), and `copy_note` lists `read:notes` among its required scopes.
