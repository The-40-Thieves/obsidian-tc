---
type: Fixed
---
- **The credential redaction scanner no longer burns ~600 steps per byte on repeated private-key BEGIN markers.** The `PRIVATE KEY` pattern was a bounded regex, but every unterminated `-----BEGIN ... PRIVATE KEY-----` still re-walked its whole 16 KB window before failing, so a caller-supplied argument made of repeated BEGIN markers cost ~2 ms per KB (about 1 s per 500 KB) before the trace size cap applied, and scaled at 3.1-3.5x per input doubling on a Windows runner. It is now a single forward pass that remembers the next END marker (about 150x faster on that input); what it matches and redacts is unchanged, including the 64-character label and 16384-byte body bounds.
