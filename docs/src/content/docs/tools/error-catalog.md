---
title: Error Catalog
description: Every canonical error code obsidian-tc can return, generated from the shared error factory so it cannot drift from the running server.
sidebar:
  order: 4
---

The complete error vocabulary, generated from the `err` factory map in
`@the-40-thieves/obsidian-tc-shared` so it never drifts from the running server. See the
[API Reference](/tools/api-reference/) for the response envelope these codes travel in, and the
[Tool Catalog](/tools/tool-catalog/) for the surface that raises them.

Errors arrive in the standard MCP error shape. The `code` below is what appears in the structured
payload; it is stable across releases and is what a client should branch on. Messages are defaults
and may be replaced at the throw site with something more specific about the failure.

:::note
This table is generated from the error factory (`bun run docgen:render`). Do not hand-edit the
region between the markers — add the error to the shared `err` map and regenerate.
:::

<!-- BEGIN GENERATED: errors -->

<!-- END GENERATED: errors -->

## Reading the Recovery column

Recovery hints say *what to do instead*; the `retryable` flag on the error says *whether* to retry.
They are deliberately separate — a code can be non-retryable and still have a clear next step.

A hint is a fixed string chosen by `code` alone. No path, query, caller, vault or argument is in
scope where it is selected, so a hint cannot leak vault content by construction rather than by
review. An em dash means the taxonomy declares no hint for that code — a considered choice, made
because guidance that only restates the message is noise, not an omission.

Where a failure can name specifics, those arrive in the error's `details` object (for example
`details.required` on `forbidden`, or the offending field on `validation_error`). Read `details` in
preference to parsing message text.
