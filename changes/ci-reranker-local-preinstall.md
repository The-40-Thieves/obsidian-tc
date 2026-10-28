---
type: Changed
---
- **CI: the full suite pre-installs the local reranker's dependencies once per job.** `packages/reranker-local` is deliberately not a root workspace member, so its reranker tests downloaded its ~230 MB dependency tree three times per run inside a 180-second kill timer. The server and native CI jobs now install it once, and the bun cache key covers its lockfile. A timed-out or failed staging step now names its command, directory and stderr tail instead of a generic hook timeout. No runtime or published-package behaviour changes.
