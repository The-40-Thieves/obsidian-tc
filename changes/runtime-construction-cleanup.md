---
type: Fixed
---
- **Failed startup releases its database and tracing resources.** Store migrations, identity setup, early telemetry setup, and later transport failures now unwind every acquired resource in reverse order. Cleanup failures are reported without hiding the original startup error; normal store shutdown still reports close failures and attempts each handle exactly once.
