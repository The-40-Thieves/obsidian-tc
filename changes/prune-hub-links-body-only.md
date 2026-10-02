---
type: Fixed
---
- **`prune_hub_links` no longer edits a note's properties.** It scanned the whole file, frontmatter included, so an unresolved property link such as `author: "[[Ghost]]"` was blanked to `author: ""`, and a property link to a note made a later body link to the same note count as a duplicate. It now prunes body links only: the frontmatter block is carried through byte-for-byte, property links (scalars, lists, aliases) are neither removed nor counted, and `removed[].line` still reports a line of the whole file.
