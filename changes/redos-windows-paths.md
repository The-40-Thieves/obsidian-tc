---
type: Fixed
---
- **The ReDoS gate runs clean on Windows.** `scripts/check-redos.mjs` matched its allowlist against backslash paths there, so every allowlisted regex was reported as failing and every entry as stale; paths are now compared with forward slashes on every platform.
