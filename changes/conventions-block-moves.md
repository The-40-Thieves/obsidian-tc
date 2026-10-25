---
type: Changed
---
- **Moves and copies are judged against their source.** A move or copy is now checked under the destination folder's `block` rules, with the source note's own violations under the source folder's rules as the baseline. A rename within a folder, a move between folders with the same rules, and a move into a looser folder pass. A move or copy into a stricter folder whose `block` rule the note breaks is refused with `convention_blocked`, and nothing is written. `bulk_move_notes` with `dry_run` reports a `would_block` entry on each row that would be refused. A move or copy from a note the caller cannot read is never refused by a convention rule, so the result never reveals that note's frontmatter.
