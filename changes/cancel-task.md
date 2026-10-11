---
type: Added
---
- **A client without the Tasks extension can now cancel a long tool call.** `cancel_task` takes the `task_id` from the handle a long call returns (`index_vault` on a large vault does) and asks the task to stop. It is the cancel half of `get_task_status`, for Claude Code, Codex, Cursor and other clients that cannot use `tasks/cancel`. Cancellation is cooperative, so the reply may still say `working`; poll `get_task_status` to see it end as `cancelled`. A task that already finished is returned unchanged, and a missing, foreign or internal id answers `not_found`. The handle text now names the tool. `tasks/cancel` also stops rewriting an already-failed task as cancelled.
