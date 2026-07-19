# docs-ingest (THE-444)

Vendor / external-docs ingestion for obsidian-tc. Produces the corpus that `knowledge_search`
and `knowledge_get_critical` serve, kept separate from the private vault.

## Pipeline

```
source (URL or file)
  -> select_parser()        # Docling (PDF/Office) | Firecrawl (web) | passthrough (md)
  -> parse -> Markdown
  -> LangExtract            # grounded {title, content, category, severity, source} chunks
  -> write md+frontmatter   # into the corpus vault dir
  -> obsidian-tc indexes it -> knowledge_search / knowledge_get_critical
```

Live Docling / Firecrawl / LangExtract backends load lazily (install the `parse` / `extract`
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

## Status

Scaffold (THE-444 increment 3): the parse-router, the writer, and the dry-run pipeline are
implemented and tested. The live LangExtract extraction (prompt + few-shot schema) and the
crawl driver are the next increment.

## Dev

```
uv sync --extra test
uv run pytest        # router + writer + dry-run pipeline
uvx ruff check .
```
