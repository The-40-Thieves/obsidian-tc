---
type: Changed
---
- **The local embedder is now opt-in for npm installs.** `npm install obsidian-tc` no longer installs `@the-40-thieves/obsidian-tc-embedder-local`, which pulled about half of the install tree even for users on a hosted or Ollama embeddings provider. To use the default `local` embedder, install the same version: `npm install -g @the-40-thieves/obsidian-tc-embedder-local@<same version>` (drop `-g` for a project install). `obsidian-tc setup` offers to run that install, and prints the exact command when it cannot ask (no TTY, `--yes`, or `--dry-run`).
