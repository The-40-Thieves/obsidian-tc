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
