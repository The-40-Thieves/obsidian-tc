# Contributing to obsidian-tc

Thanks for considering a contribution. This project is in early design (G2). Code contributions are not yet meaningful — the tool surface and architecture are still being specified.

## Current phase: G2 Design

The architecture is being designed across five sub-documents:

- **G2.1** Tool surface specification
- **G2.2** Architecture and topology
- **G2.3** Storage and schema
- **G2.4** Security and operational
- **G2.5** Release engineering

Each lands as a separate design document before code begins.

## How to help right now

- Open issues with feature requests, especially Obsidian operations you'd want a comprehensive MCP to expose.
- Open issues with safety concerns about MCP servers exposing vault data to autonomous agents.
- Comment on architecture decisions if you have prior art to share.

## Once code begins (post-G2)

Standard fork → branch → PR workflow.

- Use [Conventional Commits](https://www.conventionalcommits.org/).
- Test coverage ≥80% on new code.
- Update relevant package CHANGELOG.
- Sign commits when possible.

## Development setup (preview)

```bash
git clone https://github.com/The-40-Thieves/obsidian-tc.git
cd obsidian-tc
bun install
bun run build
bun test
```

Full setup will be properly documented in G2.5 (Release Engineering).

## Code of Conduct

All participants agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

By contributing, you agree your contributions are licensed under Apache 2.0.
