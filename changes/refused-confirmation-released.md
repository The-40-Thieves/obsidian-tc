---
type: Fixed
---
- **A refused confirmed call no longer spends its confirmation.** A call refused before any effect (for example a `convention_blocked` destination on a real `bulk_move_notes` run) now releases the single-use confirmation token, as it already releases the idempotency claim. The token stays bound to the same tool and arguments, keeps its original expiry, and is still spent by any call that commits an effect or succeeds.
