---
type: Security
---
- **Python services move to the latest dependency releases on Python 3.14.** The bge-m3-service hashed locks and the docs-ingest `uv.lock` are recompiled against current releases (torch 2.14.1, transformers 5.19, sentence-transformers 6.1, docling 2.135, fsspec 2026.7, multidict 6.9.1, ruff 0.16.10), clearing every `osv-scanner` finding under `services/`. `sentence-transformers` is no longer capped below 6; `huggingface-hub` stays below 2 because transformers 5.x requires it. Redeploy the model service to pick up the new lock.
