---
type: Fixed
---
- **Stabilized the auth rotation grace-window tests on slow runners.** Each test now has the
  stall-sized timeout, and each call collects only the stdout it wrote, so a timed-out test can no
  longer leak JSON into the next test's output.
