---
type: Security
---
- **OAuth endpoints now give a request body 10 s to arrive.** A body that stalls answers 408 and closes the connection, and a body over 16 KiB answers 413 and closes it. Under Node, the server now enforces a 120 s request timeout, checked every second.
