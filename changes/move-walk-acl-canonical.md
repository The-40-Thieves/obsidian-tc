---
type: Security
---
- **Move tools judge a walked note's readability on its canonical identity, not the walked path.** `move_note`'s backlink warnings and `bulk_move_notes`' caller-visible report filtered walked paths with a lexical folder-ACL check, so a path reached through a symlinked folder was judged by the alias name rather than by the note `read_note` would actually serve. Both now share `read_note`'s canonical, symlink-resolved read decision, and the `check:acl-identity` gate follows a readability predicate passed as a callback so a lexical check cannot return to either walk. No caller-visible change for vaults without symlinked folders; where a denied note linked a moved note, `bulk_move_notes` already reported `hidden_backlinks` and continues to.
