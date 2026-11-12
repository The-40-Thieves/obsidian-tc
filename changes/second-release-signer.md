---
type: Security
---
- **A second key may sign release tags.** `.github/allowed_signers` now lists the maintainer's Windows signing key beside the existing release key, so a `v*` tag signed with either one verifies. Releases are still verified only against `main`'s copy of the list.
