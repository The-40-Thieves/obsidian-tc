---
type: Security
---
- **A request whose body the server rejects unread now gets `Connection: close`.** A caller could hold a connection open with a declared request body it never sent, for the whole idle timeout (about four minutes under Bun). Such responses now close the connection, so incomplete uploads cannot hold connections. A request whose body the server reads keeps its connection.
