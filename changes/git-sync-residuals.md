---
type: Fixed
---
- **The `-git` image shuts down and refuses unsafe switches more reliably.** A dirty detached HEAD is no longer checked out over when a branch is configured: boot refuses it, as it already refuses a dirty other branch. A SIGTERM or SIGINT during the initial clone now aborts it, leaving the vault empty. A second signal no longer kills the launcher before the server child is reaped. The image runs `tini` as PID 1, so git and ssh processes orphaned by a killed fetch or push are reaped instead of left as zombies.
