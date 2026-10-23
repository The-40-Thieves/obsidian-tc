---
type: Security
---
- **Updated `ip-address` to 10.7.4** (GHSA-rxp7-6hxx-x8q5: `Address6` parsed a zone identifier in quadratic time before applying its length limit, so one long string could stall the process). The override floor is raised to `>=10.7.4` so the lockfile cannot resolve back to a vulnerable release.
