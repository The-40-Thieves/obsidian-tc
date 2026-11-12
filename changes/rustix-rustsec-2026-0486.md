---
type: Security
---
- **Native addon: rustix 1.1.6.** Picks up the fix for RUSTSEC-2026-0486 (rustix's extended-attribute functions could mark unwritten buffer bytes as initialised). The addon's own source makes no extended-attribute calls; the bump clears the advisory gate.
