---
type: Changed
---
- **CI: the macOS Intel legs run tests with a 15 s timeout floor.** The hosted Intel runners are the slowest legs, and tests that spawn `bun` exceeded Vitest's 5 s default there. A new `VITEST_TIMEOUT_FLOOR_MS` setting raises the non-Windows timeouts on those legs only; every other platform is unchanged. The macOS Intel CI legs now run on pushes to main and nightly, not on pull requests or the merge queue.
