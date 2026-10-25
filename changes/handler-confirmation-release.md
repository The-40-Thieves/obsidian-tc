---
type: Fixed
---
- **A confirmation a tool checks inside its handler is released on a pre-effect refusal too.** When the handler's own write gate refuses the confirmed call with `convention_blocked` before any write, the single-use token is handed back. Today only `update_task` reaches this path, since the other handler-confirmed tools refuse in a conventions preflight before the token is spent. It keeps its original expiry and bindings, a retry with the same arguments runs once the input is corrected, and each release is recorded as an `hitl_released` event. A handler that signals an effect, or fails for any other reason after the confirmation, keeps the token spent.
