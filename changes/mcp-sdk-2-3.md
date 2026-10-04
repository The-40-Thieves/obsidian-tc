---
type: Changed
---
- **MCP SDK 2.3.0.** `@modelcontextprotocol/server` moves from 2.2.0 to 2.3.0. Nothing changes on the wire. The SDK's one-connection-per-server rule already holds here: the HTTP handler builds a server per request and stdio connects once, and a test now drives two overlapping HTTP requests and a stdio round trip.
- **A `tools/call` whose arguments hold more than 500,000 array elements and object members is refused** with a validation error result, and the connection keeps serving. The largest call any tool's schema allows is about 500 (`bulk_set_property`), so no legitimate call is affected; the cap only cuts off a request body built to make the validator walk millions of elements.
