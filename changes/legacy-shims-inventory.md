---
type: Changed
---
- **Legacy-era protocol code is inventoried.** `LEGACY_SHIMS.md` lists every 2025-11-25 code path, with its reason and the steps that delete it, and each legacy-only block carries a `// legacy-era shim: see LEGACY_SHIMS.md` line. New protocol-facing code targets 2026-07-28 (see "Protocol eras" in `CONTRIBUTING.md`). No behaviour change.
