---
type: Added
tool-description-change: get_conventions
---
- **New `get_conventions` tool returns the vault conventions that apply to a note or folder.** It lists the `SCHEMA.md` layers that carry a `conventions:` block, root first, with the merged required frontmatter and allowed values, each entry naming the layer it came from. Layers the caller cannot read are left out. `start_session` now also returns the root layer's rules (concise form) to a caller that holds `read:notes`.
