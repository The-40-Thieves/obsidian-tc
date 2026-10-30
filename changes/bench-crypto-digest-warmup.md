---
type: Fixed
---
- **CI: the `chunkNote::small note` benchmark no longer reports false regressions.** The markdown benchmarks hash every chunk, and node builds its digest tables on a process's first `createHash` at a cost of two syscalls. That one-time setup landed inside the measured region, so the benchmark was bimodal - ~511us without the init and ~718us with it - and CodSpeed reported the flip as a ~29% regression on pull requests that touched no markdown code. The bench file now hashes once at module load, outside every measured region. No runtime or published-package behaviour changes.
