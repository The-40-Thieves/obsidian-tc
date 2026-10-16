---
type: Fixed
---
- **Stabilized Bun-powered server tests on Windows.** Test workers now share a repo-local runtime
  transpiler cache, avoiding repeated cold cache bursts when each file uses an isolated home.
