# obsidian-tc (server)

MCP server for Obsidian. Comprehensive tool surface for humans and autonomous agents.

This is the main package — published to npm as `obsidian-tc`.

See the [repo root README](../../README.md) for project overview and the
[ARCHITECTURE](../../ARCHITECTURE.md) record for the dispatch pipeline and topology.

## Status

✅ **Shipped — v1.9.0.** The full tool surface (141 tools across 31 domains, milestones
M0–M7) is implemented and released. Built on Bun + Hono with Zod 4 schemas; runs under
Node `>=24` (the test suite runs vitest under Node for `node:sqlite`).

```bash
npm install -g obsidian-tc
obsidian-tc /path/to/vault            # zero-config: single vault "main", all defaults
obsidian-tc serve ./config.json       # or a config file (multi-vault, auth, ACLs, embeddings)
```

## CLI commands

Beyond `serve`, the CLI ships an offline command family that runs against the same
config + caches (no server needed):

| Command | What it does |
| --- | --- |
| `config show / validate` | Print the effective config (secrets redacted) / validate it |
| `plugin install --vault <p>` | Copy the companion plugin into a vault |
| `cluster [--k N]` | Recompute chunk clusters for diversified retrieval |
| `activation-recompute` | Fold the retrieval log into ACT-R activation scores |
| `citation-infer --transcript <f>` | Stamp `cited_in_response` on retrieval events from a session transcript |
| `contribution-report` | Per-note output-contribution report (top contributors + dead-retrieved) |
| `prefetch [--vault id] [--ttl-hours N]` | Prewarm the session-bootstrap context cache (TTL enforced at read) |
| `reflect [--max-judged N]` | Sleep-time pass: stamp episode eligibility + update the preference profile |
| `metrics [--since ms] [--until ms] [--json f]` | Knowledge-health scorecard from the derive layer |
| `gaps --queries <f> / --calibrate <golden.yaml>` | Knowledge-gap detector / threshold calibration |
| `forget (--episode <id> \| --note <rel>) [--erase] / --verify` | Dependency-aware deletion + hash-chained audit |
