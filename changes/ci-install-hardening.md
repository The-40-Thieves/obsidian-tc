---
type: Changed
---
- **CI: the remaining downloads and installs are hardened.** Every `curl` download in the workflows forces HTTPS on redirects, and every CI and Dockerfile `bun install` skips lifecycle scripts, except the one job that exists to exercise the real install path. The Python CI installs are hash-verified or pin every package, and the bootstrap `pip` and `uv` are pinned. No runtime or published-package behaviour changes.
