---
type: Added
---
- **`conventions.protectSchemaFiles` makes block rules hold against note writers.** Set it on a vault and creating, editing, deleting, moving or renaming any `SCHEMA.md` (the root one included) requires the `admin:conventions` scope (also granted by `admin:*`, `*` or `admin`); without it the call is refused with `acl_denied`, reason `schema_file`. The key binds only callers whose token lacks `admin:conventions`: stdio callers and `auth.mode: none` callers hold `*`, so it does nothing for them. Reads are unchanged, and `inspect_acl` reports the refusal as `schema_file`. `move_note`, `bulk_move_notes` and `move_attachment` leave a protected layer alone and report it under `schema_not_updated`. The default is `false`, so no vault changes behaviour until it sets the key.
