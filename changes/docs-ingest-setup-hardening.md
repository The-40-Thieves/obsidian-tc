---
type: Fixed
---
- **`docs-ingest setup` hardening and usability.** A saved URL with a username or password is masked in its prompt and rejected like a new value. Redirect targets and escaped environment secrets are masked in every case and escaped form. A host with whitespace is rejected. The setup file is saved atomically through a 0600 temp file. A required prompt gives up on a non-terminal stdin instead of re-asking forever. Every bad setting is reported in one run. An explicit empty optional flag clears its key, and re-saving keeps comments and unknown keys.
