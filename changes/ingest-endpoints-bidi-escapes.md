---
type: Changed
---
- **Docs ingest no longer ships a private-network default.** `CRAWL4AI_URL` and `LANGEXTRACT_BASE_URL` have no default now; a live ingest that needs one unset fails naming the variable, and the service README documents both (either may be an `https://` endpoint). Set them before running a web or extraction ingest; `dry_run` needs neither. The eval scripts default to `http://localhost:4001/v1`. Bidi and zero-width characters in the detector sources are written as `\uXXXX` escapes, and `check:bidi` in the lint job fails on a literal one.
