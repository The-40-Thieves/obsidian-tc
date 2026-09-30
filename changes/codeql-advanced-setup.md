---
type: Changed
---
- **CodeQL now runs from `.github/workflows/codeql.yml` (advanced setup) instead of GitHub's default setup.** Default setup cannot run on `merge_group`, so the required `Analyze (...)` checks could never report on a merge-queue entry. The workflow keeps the same four languages (`actions`, `javascript-typescript`, `python`, `rust`), the default query suite and the same check names (#1054). Maintainers: default setup must be switched off before this lands, because GitHub rejects advanced SARIF uploads while it is on.
