---
type: Added
---
- **`conventions.protectSchemaFiles` makes block rules hold against note writers.** Set it on a vault and creating, editing, deleting, moving or renaming any `SCHEMA.md` (the root one included) requires the admin scope; without it the call is refused with `acl_denied`. Reads are unchanged, and `inspect_acl` reports the refusal as `schema_file`. The default is `false`, so no vault changes behaviour until it sets the key.
