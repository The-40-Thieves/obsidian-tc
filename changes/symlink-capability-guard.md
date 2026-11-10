---
type: Fixed
---
- **Server tests skip symlink cases on hosts that cannot create symlinks.** On Windows without the symlink privilege, 32 tests failed with `EPERM` instead of skipping. They now check a shared capability probe (`packages/server/test/symlink-capability.ts`); under `CI` an incapable host still fails, so CI keeps the coverage.
