---
type: Security
---
- **Bumped Pillow from 12.3 to 13.0.0 in the docs-ingest service.** Pillow 12.3 carried nine advisories that are fixed in Pillow 13.0.0. The docling family (docling, docling-core, docling-parse and docling-ibm-models) lifted its `pillow<13` cap in its latest release, so the lock now resolves Pillow 13 with it. The `parse` extra also declares `pillow>=13` so the floor cannot regress.
