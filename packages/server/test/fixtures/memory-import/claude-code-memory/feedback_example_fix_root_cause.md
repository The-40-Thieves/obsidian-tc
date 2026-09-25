---
name: feedback-example-fix-root-cause
description: "Fixture fact: a bug report names a symptom, fix the shared function once"
metadata:
  type: feedback
  originSessionId: 00000000-0000-0000-0000-000000000000
  modified: 2026-01-01T00:00:00.000Z
---

Invented fixture content: when a report names one broken call site, grep every caller of the
function you touch and fix the shared function once instead of patching only the named path.
