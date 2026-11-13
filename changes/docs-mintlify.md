---
type: Changed
---
- **The documentation site moved from Astro Starlight to Mintlify.** The pages stay in `docs/src/content/docs`, with the navigation in that folder's `docs.json`; `bun run build` in `docs/` generates the tool reference pages and assembles the finished site, and `bun run check` runs `mint validate` and `mint broken-links`. On `main`, CI publishes the site to the `docs-site` branch, which The 40 Thieves Mintlify hub serves under `/reliquary-tc`. Section links keep the anchors the old site used. The GitHub Pages deploy is retired.
