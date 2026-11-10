---
type: Security
---
- **Repository scripts no longer let the OS search `PATH` for the tools they start.** The gates, release, proof and evaluation scripts started `git`, `bun`, `node`, `docker`, `tar`, `rg`, `shellcheck` and the agent CLIs by bare name. `bun run` puts `node_modules/.bin` first on `PATH`, so a dependency shipping a bin of the same name would have been run instead. A shared resolver (`scripts/lib/trusted-exec.mjs`) now walks `PATH` itself, skips directories inside the repository and relative or empty entries, and hands the scripts an absolute path. A tool that is only reachable through a skipped directory is reported as not found. Development tooling only; nothing shipped in the server changes.
