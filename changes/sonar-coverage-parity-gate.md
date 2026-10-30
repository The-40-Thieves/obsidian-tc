---
type: Added
---
- **CI gates `sonar.coverage.exclusions` against vitest's coverage `exclude`.** The two lists
  describe one decision — which source files are deliberately uninstrumented — in two files with
  nothing connecting them, and drift distorts the reported coverage either way. The gate fails when
  a vitest exclude is missing from Sonar, which scores the file 0% although nothing instruments it,
  and when Sonar excludes a `packages/server/src` file vitest still instruments, which hides
  coverage the suite actually measured. Matching is pattern-aware rather than a literal diff, so a
  glob already covered by `sonar.exclusions` passes without a duplicate entry.
