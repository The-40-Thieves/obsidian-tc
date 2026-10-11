---
type: Fixed
---
- **A finished task's result now carries a text block, on every path that returns one.** The queue stores the tool's raw data record, so `tasks/get` (and the `notifications/tasks` payload) and `get_task_status` handed a client that reads only text a `result` with nothing in `content` to read, while the same call made synchronously always has one. The shaping now happens once, in the shared task projection, so `result` is the call's own result (`content` text block plus `structuredContent`), identical to the synchronous one; a failed task whose recorded error has no message now says so instead of returning an empty string. `get_task_status`'s `result` changes from the bare data record to that `CallToolResult`.
