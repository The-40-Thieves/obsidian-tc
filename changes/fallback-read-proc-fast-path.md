---
type: Changed
---
- **Avoid redundant fallback vault read checks on Linux.** Pure-JavaScript fallback reads now skip
  the second directory walk when procfs confirms that the opened file descriptor resolves to the
  expected canonical path, while retaining the existing directory verification when procfs is
  unavailable.
