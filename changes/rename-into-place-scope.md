---
type: Changed
---
- **SECURITY.md names rename-into-place as out of scope.** A local process that can rename directories or files inside the vault is trusted: an ordinary directory or file renamed into an allowed path mid-read keeps that path, so no backend's path check can detect it.
