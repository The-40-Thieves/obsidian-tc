---
type: Added
---
- **CI: continuous benchmarking with CodSpeed.** A new `codspeed` workflow measures the native Rust kernels (`packages/native/benches`, Criterion through `codspeed-criterion-compat`) and the server's note-parsing and retrieval hot paths (`packages/server/bench`, vitest 5 with `@codspeed/vitest-plugin`) under CPU simulation on every pull request and push to `main`. Run the TypeScript suite locally with `bun run bench` in `packages/server`, and the Rust one with `cargo bench` in `packages/native`. No runtime or published-package behaviour changes.
