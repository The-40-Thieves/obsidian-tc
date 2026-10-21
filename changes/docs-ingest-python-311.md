---
type: Changed
---
- **`docs-ingest` now requires Python 3.11 or later.** Pillow 13.0.0 is the only release that fixes its open advisories (one critical, six high, two medium), and it needs Python 3.11. With the 3.10 floor, the dependency resolver could not move past Pillow 12.3.0. Python 3.10 reaches end of life this month, and CI already tests on 3.14. `bge-m3-service` keeps its 3.10 floor. Pillow itself moves to 13 once docling releases its Pillow 13 support.
