---
type: Security
---
- **execute_template and a caller-named create_periodic_note template now require read:notes.** A template's content lands in the output, so a caller may name a template only when it can read notes (`read:notes`, and the read ACL on the template), as `move_note` already requires read on its source. Tokens calling `execute_template` now need `read:notes` in addition to `write:templater`, and `create_periodic_note` with a `template_override` needs `read:notes`. The periodic-notes template the operator configured is exempt.
