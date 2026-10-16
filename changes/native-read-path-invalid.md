---
type: Fixed
---
- **Native vault reads no longer hang on a FIFO, and both backends classify non-files the same way.** The native read opened the file without `O_NONBLOCK`, so a named pipe with no writer inside the vault blocked the server indefinitely. Reading a directory or a FIFO now reports `path_invalid` on both the native and the fallback backend; symlinks remain access refusals.
