---
type: Security
---
- **Judge the file Templater writes, not the target as given.** `execute_template` authorized, confirmed and checked for an existing file the raw `target`, but the companion writes `<target>.md` when the target has no `.md` suffix. The write ACL, the confirmation fingerprint, the overwrite check and the request sent to the companion now all name that Markdown path. A write grant on an extensionless path no longer covers the file a template creates, so grant the `.md` path instead. An implicit `wiki/log.md` rule now also covers `wiki/log` and `wiki/./log`, and a confirmation whose file changed after it was raised is refused as a replay drift.
