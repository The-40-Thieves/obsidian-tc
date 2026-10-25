---
type: Security
---
- **Entity name clashes are unchanged and now documented.** `create_entity` and `rename_entity` still answer a clash with an entity the caller cannot read as `entity already exists`, the one-bit residual described in SECURITY.md. No behaviour changed; tests now pin it so it cannot widen.
