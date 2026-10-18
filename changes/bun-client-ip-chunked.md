---
type: Security
---
- **Under Bun, a chunked request to the OAuth endpoints lost its client IP, which skipped the per-IP rate limits.** The client address is now read before any middleware runs, so a chunked `POST /oauth/login` counts against the same per-IP login limit as a request with a `Content-Length`.
