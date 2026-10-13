---
type: Fixed
---
- **The release image boot smoke can pull its second platform.** After smoking linux/amd64 it removes the image before pulling linux/arm64 of the same digest; the classic Docker image store refused the second pull with "cannot overwrite digest", which stopped the v1.33.0 image before signing and promotion and skipped the GitHub release draft behind it.
