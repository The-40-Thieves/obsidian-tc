"""Orchestrate a source through route -> parse -> extract -> write.

The live Docling / Firecrawl / LangExtract backends are imported lazily, so the router and
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
    if kind == "firecrawl":
        return _parse_firecrawl(source)
    raise ValueError(f"unknown parser kind: {kind}")


def _parse_docling(source: SourceRef) -> ParseResult:
    from docling.document_converter import DocumentConverter

    md = DocumentConverter().convert(source.uri).document.export_to_markdown()
    return ParseResult(markdown=md, source=source, parser="docling")


def _parse_firecrawl(source: SourceRef) -> ParseResult:
    from firecrawl import FirecrawlApp

    doc = FirecrawlApp().scrape_url(source.uri, params={"formats": ["markdown"]})
    return ParseResult(
        markdown=doc.get("markdown", ""), source=source, parser="firecrawl"
    )


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
