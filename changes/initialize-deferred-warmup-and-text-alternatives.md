---
type: Fixed
---
- **The boot reconcile no longer runs ahead of the first request, and every non-text result block has a text alternative.** The vault walk that starts the reconcile used to run before the transport connected; it now starts after the first client finishes `initialize` (or after a 2 s cap), and it takes an event-loop turn every 64 notes so `tools/call` and SIGTERM are serviced during a long pass. A tool result whose only content is an image, audio, `resource_link` or embedded resource block now also carries a text block naming it (media type and size, or the URI), for clients that drop those blocks (Grok Build) or replace images with a placeholder (the Claude API connector). No tool emits such a block today, so no output changes. No action needed.
