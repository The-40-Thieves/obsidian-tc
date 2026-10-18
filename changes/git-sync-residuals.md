---
type: Fixed
---
- **The `-git` image shuts down and refuses unsafe switches more reliably.** When a branch is configured and the clone sits on a detached HEAD with uncommitted changes, boot now refuses to switch, as it already did for a dirty checkout of another branch. A SIGTERM or SIGINT during the initial clone now aborts it, leaving the vault empty. A second signal no longer kills the launcher before the server child is reaped. The image runs `tini` as PID 1, so git and ssh processes orphaned by a killed fetch or push are reaped instead of left as zombies.
