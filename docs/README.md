# Documentation

The obsidian-tc documentation site is an [Astro Starlight](https://starlight.astro.build)
site whose source lives in [`src/`](./src) — install, configuration, tools, security, and
observability guides for operators. Build and preview it with the scripts in
[`package.json`](./package.json); CI publishes it from `.github/workflows/ci-docs.yml`.

This top-level `docs/` directory also holds the G2 design specifications and the operator
runbooks (`QUICKSTART.md`, `RELEASING.md`, `PORTABILITY.md`, `SYNC.md`,
`COHERENCE.md`, `CUTOVER.md`):

- `G2.1-tools.md` — Tool surface specification
- `G2.2-architecture.md` — System topology (see also the root `ARCHITECTURE.md`)
- `G2.3-storage.md` — Schema and data layer
- `G2.4-observability.md` — OpenTelemetry, Prometheus, and MORGIANA events
- `G2.4-security.md` — Auth, ACLs, and runtime governance
- `G2.5-release-engineering.md` — Build, CI, versioning, and distribution

## TypeScript pin (THE-604)

`docs/` is a separate install root (its own `bun.lock`, not part of the root workspace) and stays
on TypeScript **^6.0.3** (`package.json`), one major behind the root/`packages/shared` pin of
**7.0.2**. This is deliberate, not drift: `@astrojs/check` is pinned `^0.9.9`, and its
`peerDependencies` declare `"typescript": "^5.0.0 || ^6.0.0"`. The latest published version
(0.9.10) has the same range — no released `@astrojs/check` admits TypeScript 7 — and `astro
check` runs on the `build` script's path (`astro check && astro build`), so bumping would break
the docs build. **Revisit when `@astrojs/check` admits ^7.** Until then, a type-level example in
the docs could be valid under TS 6 and wrong against the shipped `^7.0.2` types used everywhere
else in the repo.
