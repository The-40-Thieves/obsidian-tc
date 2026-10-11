---
type: Changed
tool-description-change: patch_note, patch_active_file
---
- **`patch_note` `replace_text` needs no anchor when `old_string` is unique in the note.** With neither `anchor` nor `target_heading`, `old_string` is matched over the whole note body: frontmatter is excluded and preserved, and heading lines are in scope, so a typo in a heading can be fixed in one call. The safety is unchanged: `old_string` must occur exactly once, and 0 or 2+ matches is refused (the count is named for 2+). `append`, `prepend` and `replace` still require an anchor, and anchored `replace_text` behaves as before. `patch_active_file` takes the same rule.
