# Documentation

The reliquary-tc documentation site is a [Mintlify](https://mintlify.com) site whose pages live in
[`src/content/docs`](./src/content/docs), with its navigation and settings in that folder's
`docs.json` — install, configuration, tools, security, and observability guides for operators.

Some pages are generated from the code and never committed (the per-tool reference pages, the
decisions index, and the filled docgen regions), and Mintlify builds straight from a git tree with
no build step. So the site is assembled before it is published:

```bash
bun install          # in docs/
bun run build        # generate pages, then assemble the finished site in dist/
bun run check        # mint validate + mint broken-links (anchors included) on dist/
bun run dev          # build, then preview dist/ locally with `mint dev`
```

`scripts/build-mintlify.mjs` copies the pages and `public/` into `dist/`, lists every generated
tool page in the navigation, and makes plain-Markdown constructs MDX-safe in the copy (HTML
comments, `{`/`}`, bare `<`, `[[wikilinks]]`) while pinning each heading to the anchor ID the old
site used. On `main`, `.github/workflows/ci-docs.yml` publishes `dist/` to the `docs-site` branch,
and The 40 Thieves Mintlify hub pulls that branch in under `/reliquary-tc`.

Write pages as plain Markdown. For callouts use Mintlify components such as `<Note>`, `<Tip>` and
`<Warning>`, and use root-relative links (`/configuration/telemetry`), not `../` paths.

This top-level `docs/` directory also holds the G2 design specifications and the operator
runbooks (`QUICKSTART.md`, `RELEASING.md`, `PORTABILITY.md`, `SYNC.md`,
`COHERENCE.md`, `CUTOVER.md`):

- `G2.1-tools.md` — Tool surface specification
- `G2.2-architecture.md` — System topology (see also the root `ARCHITECTURE.md`)
- `G2.3-storage.md` — Schema and data layer
- `G2.4-observability.md` — OpenTelemetry, Prometheus, and MORGIANA events
- `G2.4-security.md` — Auth, ACLs, and runtime governance
- `G2.5-release-engineering.md` — Build, CI, versioning, and distribution
