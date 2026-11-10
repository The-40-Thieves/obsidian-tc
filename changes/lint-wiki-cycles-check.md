---
type: Added
tool-description-change: lint_wiki
---
- **`lint_wiki` reports link loops.** A new `cycles` check, on by default and in the scheduled wiki lint, proposes one `link_cycle` fix per loop of 3 to 10 notes (the loops `find_link_cycles` lists), naming every note in the loop and `read_notes` as the tool to start with. A loop counts only when every note in it is one the caller may read, is not hidden by Obsidian's Excluded files, is not a generated or raw page, and sits inside `folder` when one is given.
