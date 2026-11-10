---
type: Security
---
- **Fail closed when a vault root is unavailable.** Central path ACL enforcement and path-bound confirmations now refuse a call whose vault root cannot be resolved (`vault_not_found`) instead of skipping the check. Registry construction requires an explicit root resolver, including in CLI commands and test harnesses.
