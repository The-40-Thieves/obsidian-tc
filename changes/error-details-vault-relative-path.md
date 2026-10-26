---
type: Fixed
---
- **Refusals name notes by vault-relative path.** A `read_note`, `write_note` or `delete_note` refusal (`acl_denied`, `path_invalid`) carried the server's absolute filesystem path in `details.path`, which exposed the host layout to any authenticated caller. `details.path` is now the vault-relative path with POSIX separators, or the basename when no vault root matches.
