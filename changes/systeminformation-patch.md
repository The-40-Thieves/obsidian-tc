---
type: Security
---
- **Patch the hardware information dependency.** Raise `systeminformation` to 5.33.16, the patched version for GHSA-3f7j-7jwc-fxfj (Windows command injection in `services()`). obsidian-tc only calls the CPU and graphics readers, never `services()`, so the vulnerable path was not reachable; the bump clears the audit gate. No action needed on upgrade.
