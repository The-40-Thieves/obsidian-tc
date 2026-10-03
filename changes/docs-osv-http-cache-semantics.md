---
type: Security
---
- **Docs workspace ignores GHSA-ch52-4w7c-c8xp until 2026-11-02.** `http-cache-semantics` (no fixed release) reaches only the static docs build through `astro`; the server and CLI do not ship it. The ignore lives in `docs/osv-scanner.toml` and expires so it is re-checked.
