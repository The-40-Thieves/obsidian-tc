---
type: Added
tool-description-change: patch_note, patch_active_file
---
- **`patch_note` append can insert content above a section footer.** Set `insert_before` to a line that occurs exactly once in the resolved heading, block or preamble section. The new content lands immediately above it, while fenced-code matches and a heading anchor's own heading line are ignored. This keeps signatures, `Parent: [[...]]` links and footnote blocks at the end of a note. `patch_active_file` supports the same option.
