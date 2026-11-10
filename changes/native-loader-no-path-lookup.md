---
type: Security
---
- **The native module's loader no longer runs `ldd --version` to tell musl from glibc.** On a Linux host where the process report and `/usr/bin/ldd` were both undecided, the loader resolved `ldd` through `PATH` and executed it. It now checks whether musl's dynamic loader (`ld-musl-*.so.1`) is installed in `/lib` or `/usr/lib` instead, so libc detection reads only the running process and fixed paths. Prebuild selection is unchanged on every host those earlier probes already decided.
