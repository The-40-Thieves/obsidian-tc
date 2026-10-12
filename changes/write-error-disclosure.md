---
type: Security
---
- **Redact note-derived write diagnostics from callers who cannot read the target note.** `patch_note` and delegated `patch_active_file` refusals no longer disclose match counts, anchor line numbers, near-miss diagnostics, or large-replace line counts without both `read:notes` and read ACL access; authorized readers retain the existing detailed errors.
