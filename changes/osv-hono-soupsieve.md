---
type: Security
---
- **Dependency security updates.** `hono` moves to 4.13.18 (floor 4.13.16) for GHSA-3gg2-335m-rxc6, GHSA-46wx-v44x-9hh2, GHSA-4h7h-rv7c-7m2v, GHSA-4m76-xfj5-7975 and GHSA-h7mg-cq63-vhpq. `@hono/node-server` moves to 2.1.8 (floor 2.1.6) for GHSA-jpvv-r467-5p4w and GHSA-qv5m-9pm6-hqp3. The docs-ingest service locks `soupsieve` 4.1 for GHSA-mmhr-3c5m-f64f, and its supported Python floor rises from 3.11 to 3.14, the version CI tests. The lock no longer carries the older-Python-only versions of soupsieve, numpy, scipy and networkx.
