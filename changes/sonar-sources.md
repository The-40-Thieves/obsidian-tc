---
type: Fixed
---
- **SonarQube Cloud was analysing nothing.** `sonar-project.properties` set `sonar.tests` without
  its counterpart `sonar.sources`, which left the scanner with zero main source files: the first
  CI-based analysis of `main` reported no `ncloc` at all, imported no coverage, and passed its
  quality gate because there was nothing left to measure. Setting `sonar.sources` restores the
  repository-root scope and lets the LCOV report attach to the files it covers.
