---
type: Changed
---
- **CI: six pinned GitHub Actions move to their current patch releases.** `setup-node` and `setup-python` go to v7.1.0, `upload-artifact` to v7.0.2, `download-artifact` to v8.0.2, `rust-cache` to v2.9.3 and `deploy-pages` to v5.0.1. Every use is still pinned to a full commit SHA. No runtime or published-package behaviour changes.
