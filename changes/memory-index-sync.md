---
type: Fixed
---
- **Memory notes show up in search as soon as the tool returns.** `create_entity`, `link_entities`,
  `unlink_entities`, `add_observation`, `update_observation`, `rename_entity` and `delete_entity` now
  re-index the projection notes they write and de-index the ones they remove, once the call has
  committed. A search made right after one of these calls no longer misses the new fact, and a
  renamed or deleted entity's old note no longer lingers in the index. A failing index hook never
  fails the call.
