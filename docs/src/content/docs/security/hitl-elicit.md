---
title: HITL Elicitation & the Governor
description: Human-in-the-loop confirmation for sensitive actions and the response-size governor.
---

## Human-in-the-loop elicitation

Sensitive operations require explicit human confirmation before they run. The
server issues an MCP **elicitation** request; the action proceeds only once the
human approves. Approval is single-use: it is consumed at the point the handler
runs (emitting `tc.elicit.consumed`), and a fresh request (`tc.elicit.requested`)
is required for the next sensitive call. The approval is bound to the exact vault, tool,
argument hash, and **issuing caller**, so on a multi-caller HTTP deployment one caller cannot
redeem another's approval.

The elicitation thresholds are **hardcoded floors** — a client cannot configure
them away. This keeps the confirmation gate present even under a permissive config.

## The response governor

A shared **governor** caps the byte size of any single tool response
(`governor.maxResponseBytes`). When a result would exceed the cap the call is
**refused** with an `overflow` error (rather than returning an unbounded payload);
the refusal is counted (`governor_truncations_total`) and emitted as
`tc.governor.overflow`. This bounds memory and protects clients from
pathologically large payloads.

See [Observability](/observability/prometheus/) for the counters these emit.
