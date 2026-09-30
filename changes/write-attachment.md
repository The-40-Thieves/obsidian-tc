---
type: Added
---
- **`write_attachment`: write binary attachments into a vault (#1048).** The attachment family could list, read,
  move and delete files but had no way to create one (`docs/CUTOVER.md` listed `vault_write_binary` as
  having no equivalent). `write_attachment({ vault, path, content, mime_type?, overwrite? })` takes the
  bytes as strict base64 (standard alphabet, padded, canonical; whitespace, the URL-safe alphabet and
  `data:` URIs are refused) and writes them atomically (temp file + rename through the same symlink-safe
  open the note writers use). A bare filename lands in the vault's configured attachment folder
  (`attachmentFolderPath`); a path with a folder is used as given. Only extensions on the attachment
  allowlist that `get_attachment` uses are accepted, so `.md`, `.canvas` and `.base` are refused (they
  have their own tools), and `mime_type`, when sent, must match the extension. The payload is capped by
  the new `writes.maxAttachmentBytes` (default 25 MB decoded, ceiling 50 MB), checked from the base64
  length before anything is decoded; the payload travels inline as base64, about 4/3 of the cap, so lower
  it if a client or proxy limits message size. The call needs `write:attachments` and passes the folder
  ACL (including per-vault overrides) on the resolved target path; control directories such as
  `.obsidian/`, `.git/` and `.trash/` are always refused. An existing file is refused unless
  `overwrite` is set; overwriting requires confirmation, is bound to the target's state (`replay_drift`
  if the file changed after the request) and soft-deletes the prior bytes to `.trash/`, like
  `move_attachment`. Attachment bytes are not content-scanned, but a secret-shaped path is refused like
  any other write. To support this, `pathAcl` extractors now receive the effective vault root as an
  optional second argument, and `notes-io` gains a binary `writeFileAtomic` that `writeNoteAtomic` now
  delegates to.
