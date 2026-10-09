---
type: Added
---
- **`toolFacade.outputSchema: "omit"` for clients that mishandle an advertised `outputSchema`.** The default `"full"` is today's behaviour. `"omit"` drops `outputSchema` from every tool `tools/list` advertises (the `flat` surface; `triad` and `domain` advertise none); results are unchanged and still carry `structuredContent` plus a text block. See `docs/MCP-COMPATIBILITY.md` for which clients benefit.
