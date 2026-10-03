---
type: Fixed
---
- **The community-directory scanner's ESLint step runs again.** It lints from the repository root, and with no root `tsconfig.json` it took its untyped branch and crashed (`await-thenable requires type information`), reporting `scanner-eslint-execution-failed` instead of any finding. A root `tsconfig.json` now gives it the typed branch and owns the files no package config reaches (the eval harness and the native fallback `.js`); the build and typecheck are unchanged. `POST /files/open` no longer calls `Workspace.revealLeaf` (Obsidian 1.7.2+) on a plugin whose minimum is 1.7.0, where it would have thrown after opening the file.
