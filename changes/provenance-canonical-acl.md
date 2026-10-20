---
type: Security
---
- **get_provenance judges paths on their canonical identity.** Through a symlinked folder (`wiki -> private` with `wiki/**` readable), get_provenance returned a note's write history (principal, session, hashes) that read_note refuses. It now applies read_note's own decision to the queried path, to each record's paths and to each move hop, so an unreadable note answers exactly like a path with no records. inspect_acl evaluates the resolved target too, so it no longer reports `allowed: true` for a symlinked path whose target read_note refuses.
