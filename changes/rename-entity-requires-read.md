---
type: Security
---
- **rename_entity now needs the memory read scope.** A rename moves the entity's materialized note to its new path, so the caller must be able to read the entity as `get_entity` does: `read:memory` and the folder read ACL. A caller that holds `write:memory` alone is refused with `forbidden` before anything moves. A caller that renames entities must now also hold `read:memory`.
