---
type: Fixed
tool-description-change: patch_note, patch_active_file
---
- **`patch_note` and `patch_active_file` state each operation's required and forbidden fields where clients read them, and every refusal names the operation.** A portable JSON Schema cannot express "`replace_text` needs `old_string` and `new_string` and refuses `content`; `append`, `prepend` and `replace` need `content`", so a client that pre-validates against the schema still sent calls the server refused. The rule is now in the tool description (one line per operation) and in each field's description, and each refusal names the operation and the field (`operation "replace_text" requires old_string`). The accepted calls are unchanged.
