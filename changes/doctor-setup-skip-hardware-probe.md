---
type: Fixed
---
- **`obsidian-tc doctor` and `obsidian-tc setup` no longer wait on a hardware probe they never read.** Both commands built a capability profile that ran `systeminformation`, which on Windows starts `powershell.exe` (WMI and graphics queries); the profile gave up on it after 2 s, but the child kept running and held the command open, so a cold or busy Windows machine paid seconds to a minute for CPU-brand and GPU details that neither command reports. They now use the `node:os` baseline (platform, arch, CPU count, memory) alone, which is all they ever consumed. No output changes.
