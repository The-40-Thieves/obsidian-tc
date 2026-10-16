---
type: Security
---
- **Companion bridge responses now filter declared paths and project fixed-shape results.** Daily-note, Git, command, automation, metadata, OCR, Excalidraw, and sync results drop undeclared fields. Item-list rows and make.md spaces are kept only when every declared path is readable; retained rows are otherwise passed through unchanged from the plugin payload. Opaque values scan nested paths, and malformed acknowledgements fail with a non-retryable compatibility error.
