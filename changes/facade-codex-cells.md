---
type: Changed
---
- **The docs now recommend `toolFacade.mode: domain` for Codex, from a measurement.** The Codex `domain` and `flat` cells that the first per-client study could not run (usage limit) were measured, with `triad` re-run alongside under one CLI version and model: 64 trials per mode, 192 of 192 passed, so the pre-registered rule fell through to its tiebreakers. `domain` needed a median of 2.5 calls against 5 for `triad` and had no tool-not-found against 5 trials; `flat` is not distinguished from `domain` (3 calls, 8 trials with an error against 55). Claude Code stays on `triad`, and the shipped default is unchanged.
