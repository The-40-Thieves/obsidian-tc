---
type: Security
---
- **Memory reads use `read_note`'s read check exactly.** The memory read gate (`get_entity`, `query_entity_graph`, the lookups inside the memory write and lifecycle tools, and `create_entity`/`rename_entity`'s claimed-path check) judged an entity's projection note lexically against `readPaths`, and skipped the check entirely for a vault with no `readPaths`. It now runs the same check `read_note` runs on the vault's bound root: the hard-denied roots (`.obsidian`, `.git`, `.trash`), rule-scopes, symlink resolution (a memory folder reached through a symlink into an unreadable directory hides its entities) and the hard-link refusal apply, an invalid or `..` path fails closed, and there is no shortcut for an unrestricted ACL.
