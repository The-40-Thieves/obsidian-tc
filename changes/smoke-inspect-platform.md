---
type: Fixed
---
- **The release image smoke reads the right architecture on Docker 29.** With the containerd image store, `docker image inspect` on a multi-platform digest reports the runner's own platform, so the linux/arm64 check read an empty architecture and stopped the 2.0.0 image release. The check now passes `--platform`.
