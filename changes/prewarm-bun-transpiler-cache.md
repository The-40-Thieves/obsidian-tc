---
type: Changed
---
- **Pre-warm Bun's shared runtime transpiler cache before parallel server tests.** CI now fills the cache serially and reports its file count and size before Vitest starts, avoiding a cold first wave of concurrent Bun child processes.
