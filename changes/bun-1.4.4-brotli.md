---
type: Security
---
- **Bun 1.4.4 for the Brotli decoder fix (CVE-2026-111497).** Bun 1.4.3 and earlier bundle a Brotli decoder with an out-of-bounds write that malformed compressed input can trigger. The container image, CI and the repo toolchain pin now use Bun 1.4.4, the first fixed release.
