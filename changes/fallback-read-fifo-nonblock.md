---
type: Security
---
- **Prevent fallback vault reads from hanging on swapped FIFOs.** Pure-JavaScript reads now open nonblocking and validate the opened descriptor is a regular file before reading it.
