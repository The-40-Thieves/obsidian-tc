---
type: Added
tool-description-change: get_task_status
---
- **Long tool calls now return within about 40 seconds on every client.** A call to a long-running tool (`index_vault`) from a client that did not declare the Tasks extension runs as a background task and waits up to 40 s for the result; past that it returns a handle (`status: "working"`, a `task_id`) and the new `get_task_status` tool reads the task until it is `completed` and carries the tool's own result. Clients that declared Tasks still get the handle at once. A caller that sends a `progressToken` receives `notifications/progress` while the call runs (`index_vault` reports notes processed out of notes seen). The facade (`call_capability`) and domain calls take the same path; before, only a directly named tool could become a task. stdio gets the budgeted wait too, but still does not advertise the Tasks extension, since it has no `tasks/get` route.
