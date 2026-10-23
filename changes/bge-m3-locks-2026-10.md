---
type: Changed
---
- **Refreshes the bge-m3 service locks to current releases.** The runtime lock moves fastapi to 0.161.1, pydantic to 2.14.1, sentence-transformers to 6.2.0, transformers to 5.20.2 and numpy to 2.5.4; the CI test lock moves fastapi, pydantic and starlette. Torch and FlagEmbedding are unchanged.
- **The bge-m3 service now declares Python 3.12 or newer.** It said 3.10, but the locked runtime set (numpy 2.5.4, scipy 1.18.1, networkx 3.7) already required 3.12, and starlette 1.8 dropped 3.10. Deployments already run 3.14.
