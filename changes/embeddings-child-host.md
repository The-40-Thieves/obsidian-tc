---
type: Added
config-schema-change: embeddings.host
---
- **`embeddings.host: "child-process"` runs the local embedder in a child process.** It is opt-in (the default stays `"in-process"`) and applies only to `embeddings.provider: "local"`; a child is started on the first embed, and a dead child is retried once, then the request fails through the existing degrade path. This addresses #1433. Measured on a 300-note synthetic set with `nomic-embed-text-v1.5` on the test VM: after the batch the parent process holds 53 MiB, and the parent plus child total is about 2.28 GiB, against 2.08 GiB in-process. So the total is about the same, or slightly higher, until the recycle policy lands. The gain is that the child can be stopped to return its memory to the OS, which an in-process model cannot do; nothing calls the recycle path yet.
