---
type: Changed
---
- **The local embedder is now opt-in for npm installs.** `npm install obsidian-tc` no longer installs `@the-40-thieves/obsidian-tc-embedder-local`, which pulled about half of the install tree even for users on a hosted or Ollama embeddings provider. To use the default `local` embedder, install the same version: `npm install -g @the-40-thieves/obsidian-tc-embedder-local@<same version>` (drop `-g` for a project install). `obsidian-tc setup` offers to run that install, and prints the exact command when it cannot ask (no TTY, `--yes`, or `--dry-run`).
- **Upgrading an existing npm install loses semantic search until the embedder is installed.** npm prunes the embedder that the previous release nested under obsidian-tc, so `local` cannot resolve. The server then boots text-only (lexical search still works) and `obsidian-tc doctor` names the fix. Run `obsidian-tc setup`, or the install command above.
- **A version mismatch is reported.** An embedder at a different version than obsidian-tc (for example after `npm i -g obsidian-tc@latest` alone) still loads, and boot and `obsidian-tc doctor` now say so and name the matching install.
