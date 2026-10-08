---
type: Fixed
---
- **On Windows, repairing a corrupt server secret no longer crashes when another process is removing the repair lock at the same moment.** Windows answers a `mkdir` of a lock directory that a racing process is deleting (or a link into it) with `EPERM`/`EACCES`/`EBUSY` instead of `EEXIST`, and the repairer rethrew it. That is now a lost acquisition that backs off inside the existing wait deadline, the lock cleanup rides out a briefly held handle instead of leaving an ownerless lock behind, and the takeover rules are unchanged: only a provably dead same-host holder is ever taken over. Other platforms still surface those errors.
