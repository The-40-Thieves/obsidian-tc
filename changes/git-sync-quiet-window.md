---
type: Fixed
---
- **Batched git sync commits after the quiet window.** A write that lands while a status check is in flight no longer lets the batched commit fire up to one status round early.
