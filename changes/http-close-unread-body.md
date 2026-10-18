---
type: Security
---
- **A request whose body the server leaves unread closes its connection unless the body arrives in full.** A caller could hold a connection open with a declared request body it never sent, for the whole idle timeout (about two minutes under Bun). Such a body is now drained for up to 250 ms and 4 MiB; if it does not finish within that bound, the response closes the connection. A body the server reads, or one the caller sent in full, keeps its connection.
