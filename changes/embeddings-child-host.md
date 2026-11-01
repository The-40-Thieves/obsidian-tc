---
type: Added
config-schema-change: embeddings.host
---
- **`embeddings.host: "child-process"` runs the local embedder in a child process.** It is opt-in (the default stays `"in-process"`) and applies only to `embeddings.provider: "local"`; a child is started on the first embed, and a dead child is retried once, then the request fails through the existing degrade path. This addresses #1433. Measured on a 300-note synthetic set with `nomic-embed-text-v1.5` on the test VM: after the batch the server process holds 53 MiB, against 2.1 GiB in-process, while the child peaks at 2.3 GiB; returning that memory still needs the recycle path, which nothing calls yet.
