---
type: Security
---
- **move_note and bulk_move_notes now require read access to the source note.** A caller must be
  able to read the source (the read ACL and the `read:notes` scope), as `copy_note` already requires.
  A caller that may only delete and write can no longer move a note it cannot read into a folder it
  can read.
