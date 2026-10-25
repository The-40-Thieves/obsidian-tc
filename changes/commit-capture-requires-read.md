---
type: Security
---
- **commit_capture now needs the capture read scope.** A commit writes the queued capture's body into a vault note, so the caller must be able to read the capture as `list_capture_queue` does: `read:capture` and the folder read ACL on the capture's notes. A caller that holds `write:capture` alone is refused with `forbidden` before anything is written, and the capture stays queued. Tokens that commit captures must now also hold `read:capture`.
