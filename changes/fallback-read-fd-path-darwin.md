---
type: Security
---
- **Check the opened file's path on macOS.** On macOS, the pure-JavaScript read verifies the opened file's path when a startup probe shows `/dev/fd` names the opened file, and refuses the read if that lookup fails. Windows has no descriptor-path check in either backend and relies on the ancestor re-walk.
