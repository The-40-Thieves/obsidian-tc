# docs-ingest

Vendor / external-docs ingestion for obsidian-tc. Produces the corpus that `knowledge_search`
and `knowledge_get_critical` serve, kept separate from the private vault.

## Pipeline

```
source (URL or file)
  -> select_parser()        # Docling (PDF/Office) | crawl4ai (web) | passthrough (md)
  -> parse -> Markdown
  -> LangExtract            # grounded {title, content, category, severity, source} chunks
  -> write md+frontmatter   # into the corpus vault dir
  -> obsidian-tc indexes it -> knowledge_search / knowledge_get_critical
```

Live Docling / LangExtract backends load lazily (crawl4ai is a self-hosted HTTP service,
no client library) (install the `parse` / `extract`
extras); the router + writer core need none of them. `dry_run=True` exercises the
route -> write loop with no backends, which is enough to prove the write -> index -> serve loop.

## Corpus vault wiring

The corpus is a distinct read-only obsidian-tc vault (a reserved `vault_id`) pointed at this
job's output dir, e.g. in the server config:

```json
"vaults": [
  { "id": "vendor-docs", "path": "<corpus dir>", "acl": { "readOnly": true } }
]
```

Chunks carry `severity` frontmatter so `knowledge_get_critical` can filter `severity == critical`,
and `source` so results are vendor-attributed.

## Configuration

Live runs read these settings. None has a default: a run that needs an unset setting fails with
an error naming it and pointing at `docs-ingest setup`. `dry_run=True` needs none of them.

Setup: `docs-ingest setup` (or `uv run docs-ingest setup`) prompts for each setting, shows the
current value as the default (secrets masked), validates the URLs, probes both endpoints and
writes `$XDG_CONFIG_HOME/obsidian-tc/docs-ingest.env` (default `~/.config/obsidian-tc/docs-ingest.env`)
with mode 0600. Use `DOCS_INGEST_CONFIG` to point at another file. Precedence is environment
first, then that file. An empty value counts as unset. `--non-interactive` takes the flags
`--crawl4ai-url`, `--crawl4ai-token`, `--langextract-base-url`, `--langextract-api-key` and
`--langextract-model-id`; `--no-probe` skips the endpoint checks. Probes never block the save.

| Variable | Used for | Points at |
|---|---|---|
| `CRAWL4AI_URL` | web pages (crawl4ai parser) | your crawl4ai server, e.g. `http://localhost:11235` |
| `CRAWL4AI_API_TOKEN` | optional bearer token for crawl4ai | |
| `LANGEXTRACT_BASE_URL` | LangExtract model calls | an OpenAI-compatible gateway ending in `/v1`, e.g. `http://localhost:4001/v1` |
| `LANGEXTRACT_API_KEY` | bearer key for that gateway (falls back to `LITELLM_AGENT_KEY`) | |
| `LANGEXTRACT_MODEL_ID` | optional model id (default `openai/gpt-4o-mini`) | |

Both URLs may be `https://` endpoints, and should be when they are not on localhost: a plain
`http://` endpoint carries its bearer key in clear. `setup` warns about that and still saves.

## Status

Scaffold (increment 3): the parse-router, the writer, and the dry-run pipeline are
implemented and tested. The live LangExtract extraction (prompt + few-shot schema) and the
crawl driver are the next increment.

## Dev

```
uv sync --extra test
uv run pytest        # router + writer + config + setup CLI + dry-run pipeline
uv run docs-ingest setup   # interactive; or: uv run docs-ingest setup --non-interactive --help
uvx ruff check .
```
