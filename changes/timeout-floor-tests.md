---
type: Fixed
---
- **Two server tests no longer fail on the macOS Intel legs.** The `runBunSync` kill test and the `vitest.config.ts` timeout pin assumed no timeout floor, so the Intel legs' `VITEST_TIMEOUT_FLOOR_MS=15000` stretched the 300 ms kill to the test's own timeout and broke the 5 s pin. Both now set the floor explicitly, and the config test also pins the floored values.
