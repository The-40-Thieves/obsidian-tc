---
type: Fixed
---
- **Source-checkout upgrades no longer lose dense search and reranking silently.** A root `bun install` + `bun run build` does not build the optional `embedder-local` and `reranker-local` packages, which the default `local` providers need. The root build now prints the exact `cd packages/<pkg> && bun install && bun run build` commands when either is unbuilt (it never fails). Plain `obsidian-tc doctor` also reports a resolved `local` embedder as a warning, not a pass, until `doctor --probe` has actually run it.
