---
type: Fixed
---
- **Git status and diff map paths more accurately.** On macOS and Windows, in-vault files whose case or Unicode form differs between git and disk are no longer dropped, and a symlinked vault maps correctly. Status now refuses with a retry message, rather than mis-mapping, while obsidian-git reloads its settings.
