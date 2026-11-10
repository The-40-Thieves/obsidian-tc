---
type: Security
---
- **Ticket-fetch script escapes remote diagnostic text.** `scripts/fetch-linear-tickets.mjs` neutralizes control characters in HTTP reason phrases, GraphQL error bodies and transport-error messages before writing them to stderr, so a hostile or broken upstream cannot forge log lines or terminal control sequences.
