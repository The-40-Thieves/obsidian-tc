---
type: Fixed
---
- **SonarQube Cloud was analysing nothing.** `sonar-project.properties` set `sonar.tests` without
  its counterpart `sonar.sources`, which left the scanner with zero main source files: the first
  CI-based analysis of `main` reported no `ncloc` at all, imported no coverage, and passed its
  quality gate because there was nothing left to measure. `sonar.sources` now sets the scope back
  to the repository root, and the test tree is excluded from the main set so `sonar.tests` can
  still claim it without the two overlapping.
