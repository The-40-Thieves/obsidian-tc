---
type: Added
---
- **CI: nightly StrykerJS mutation run for the shared parsers.** A non-gating scheduled workflow runs Stryker over the three pure parsers in `packages/shared` on its command runner and uploads the HTML report. It is not a required check and does not change any published package.
