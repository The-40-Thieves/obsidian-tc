---
type: Changed
---
- **The Windows spawn stall-budget guard now reads the syntax tree instead of lines.** The regex
  version missed `setup-first-run-fallback-e2e`, whose per-test timeout sits on its own line after
  the callback, and that test timed out at 20s on windows-latest within the hour. The guard now
  finds budgets by role, whatever the formatting: any numeric (or constant-folded) argument to
  `it`/`test`/`describe`/hooks, `timeout`/`testTimeout`/`hookTimeout` properties, kill timers and
  deadlines. It also picks up `Bun.spawn`, `require` and dynamically imported spawners, and test
  helpers that wrap them. The three test files it caught (`setup-first-run-fallback-e2e`,
  `stdio-eof-http-keepalive`, `shutdown-boot-embed`) now route their budgets through
  `stallTimeout`. Test-only: no runtime behaviour changes.
