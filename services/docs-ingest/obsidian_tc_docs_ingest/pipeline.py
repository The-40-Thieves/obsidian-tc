"""Orchestrate a source through route -> parse -> extract -> write.

The live Docling / crawl4ai / LangExtract backends are imported lazily, so the router and
writer (and their tests) need none of them installed. ``dry_run`` short-circuits the live
backends with a single fixture chunk, enough to prove the end-to-end loop: ingest writes
md+frontmatter, the obsidian-tc server indexes it, and knowledge_search / knowledge_get_critical
serve it.
"""

from __future__ import annotations

from pathlib import Path

from .contracts import DocChunk, ParseResult, SourceRef
from .router import select_parser
from .writer import write_chunk


def parse(source: SourceRef, kind: str) -> ParseResult:
    """Produce clean Markdown from a source using the routed parser."""
    if kind == "passthrough":
        text = Path(source.uri).read_text(encoding="utf-8")
        return ParseResult(markdown=text, source=source, parser="passthrough")
    if kind == "docling":
        return _parse_docling(source)
    if kind == "crawl4ai":
        return _parse_crawl4ai(source)
    raise ValueError(f"unknown parser kind: {kind}")


def _parse_docling(source: SourceRef) -> ParseResult:
    from docling.document_converter import DocumentConverter

    md = DocumentConverter().convert(source.uri).document.export_to_markdown()
    return ParseResult(markdown=md, source=source, parser="docling")


def _parse_crawl4ai(source: SourceRef) -> ParseResult:
    """Render a web page to Markdown via a crawl4ai server.

    Replaces the previous Firecrawl backend, which was a hosted, metered API: when its credits
    ran out every web ingest failed with HTTP 402 and there was no local fallback. crawl4ai is
    Apache-2.0 and self-hosted (Cave runs one on the tailnet), so the same Playwright/Chromium
    render costs nothing per page and cannot be cut off.

    Deliberately spoken to over plain HTTP with urllib rather than through an SDK: this package
    declares only pydantic as a hard dependency and imports its live backends lazily, so adding a
    client library for what is one POST would be a real dependency for no benefit.
    """
    import json
    import os
    import urllib.request

    base = os.environ.get("CRAWL4AI_URL", "http://100.78.123.100:11235").rstrip("/")
    payload = json.dumps(
        {
            "urls": [source.uri],
            # BYPASS: an ingest is explicitly asking for the current page, so a cached render
            # would defeat the point of running it.
            "crawler_config": {
                "type": "CrawlerRunConfig",
                "params": {"cache_mode": "BYPASS"},
            },
        }
    ).encode()

    req = urllib.request.Request(f"{base}/crawl", data=payload)
    req.add_header("Content-Type", "application/json")
    token = os.environ.get("CRAWL4AI_API_TOKEN")
    if token:
        req.add_header("Authorization", f"Bearer {token}")

    with urllib.request.urlopen(req, timeout=180) as resp:
        body = json.loads(resp.read().decode())

    results = body.get("results") or []
    if not results or not results[0].get("success", False):
        raise RuntimeError(f"crawl4ai failed to render {source.uri!r}")

    # crawl4ai returns markdown either as a string or as an object carrying several variants
    # (raw / fit / with-citations). raw_markdown is the faithful full-page render, which is what
    # an ingest wants — the "fit" variants drop content the extractor may need.
    md = results[0].get("markdown")
    markdown = md.get("raw_markdown", "") if isinstance(md, dict) else (md or "")
    return ParseResult(markdown=markdown, source=source, parser="crawl4ai")


def extract(parsed: ParseResult) -> list[DocChunk]:
    """Run LangExtract to produce grounded DocChunk records (live extraction: next increment).

    The extraction prompt + few-shot schema (targeting the self-contained-chunk style, with
    category/severity/source and char-interval grounding) is the next increment; until then
    use ``dry_run`` to exercise the write -> index -> serve loop.
    """
    raise NotImplementedError(
        "live LangExtract extraction not yet wired; use dry_run=True"
    )


def ingest(source: SourceRef, corpus_dir: Path, *, dry_run: bool = False) -> list[Path]:
    """Route -> parse -> extract -> write. Returns the corpus paths written."""
    kind = select_parser(source)
    if dry_run:
        fixture = DocChunk(
            title=f"Fixture: {source.uri}",
            content=f"Dry-run placeholder for {source.uri} (parser: {kind}).",
            source=source.vendor or "unknown",
            severity="informational",
        )
        return [write_chunk(fixture, corpus_dir)]
    chunks = extract(parse(source, kind))
    return [write_chunk(c, corpus_dir) for c in chunks]
