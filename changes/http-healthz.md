---
type: Added
---
- **HTTP liveness check.** `GET /healthz` answers `{"status":"ok"}` without authentication for process-liveness probes while retaining the HTTP Host guard.
