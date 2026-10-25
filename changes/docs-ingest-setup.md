---
type: Added
---
- **`docs-ingest setup` writes the endpoint config.** Prompts for the crawl4ai and LangExtract gateway settings (secrets hidden and masked), validates the URLs, probes both endpoints without blocking the save, and writes `obsidian-tc/docs-ingest.env` under the config home with mode 0600. Live runs read environment variables first, then that file; a missing setting's error now names `docs-ingest setup`. `--non-interactive` takes the values as flags, and a secret flag given as `-` is read from stdin.
