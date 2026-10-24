---
type: Added
tool-description-change: find_orphans
---
- **`find_orphans` can group its result by folder.** Pass `group_by: "folder"` to get a `groups`
  array with one entry per top-level folder (notes at the vault root under `"/"`): the orphan
  `count`, and the `oldest` and `newest` note modification times. Groups are sorted by count and
  cover the whole result, so `limit` and `cursor` paging do not change them. Without `group_by`
  the output is unchanged.
