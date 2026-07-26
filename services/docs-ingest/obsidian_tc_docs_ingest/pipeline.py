"""Orchestrate a source through route -> parse -> extract -> write.

The live Docling / crawl4ai / LangExtract backends are imported lazily, so the router and
writer (and their tests) need none of them installed. ``dry_run`` short-circuits the live
backends with a single fixture chunk, enough to prove the end-to-end loop: ingest writes
md+frontmatter, the obsidian-tc server indexes it, and knowledge_search / knowledge_get_critical
serve it.
"""

from __future__ import annotations

import textwrap
import typing
from pathlib import Path

from .contracts import DocChunk, ParseResult, SourceRef
from .router import select_parser
from .writer import write_chunk

# The LangExtract extraction_class every doc-fact extraction is tagged with, so mapping code
# can ignore any other class a model might invent despite the prompt.
_EXTRACTION_CLASS = "doc_fact"

_PROMPT = textwrap.dedent("""\
    Extract every self-contained, retrievable doc fact from the text: a gotcha, breaking
    change, required parameter, footgun, or rate limit -- anything a reader needs verbatim
    when integrating with this vendor's API, SDK, or CLI.

    extraction_text MUST be an exact, verbatim, contiguous span copied character-for-character
    from the source -- it becomes the stored fact, so do not paraphrase, summarize, truncate,
    or let spans overlap.

    Attach these attributes to every extraction:
      - title: a short (under 12 words) human-readable label for the fact
      - category: a short lowercase snake_case tag, e.g. "breaking_change", "rate_limit",
        "auth", "gotcha", "config"
      - severity: one of "informational", "medium", "high", "critical" -- "critical" only for
        something that silently breaks or loses data, "high" for a blocking error, "medium"
        for a footgun with a workaround, "informational" for everything else
      - source: the vendor or product the doc is about, lowercase, e.g. "context7"

    Skip marketing copy and anything with no actionable detail.
    """)

# Plain data, not lx.data.ExampleData: this module must stay importable with none of the live
# backends installed (see module docstring), so the langextract types only get built inside
# _call_langextract, where the import already happens.
_FEW_SHOT_EXAMPLES: list[dict[str, str]] = [
    {
        "text": (
            "Context7's resolve-library-id endpoint requires the library id to include a "
            "leading slash, e.g. /vercel/next.js. Omitting the slash returns a bare 404 with "
            "no other diagnostic, so 'vercel/next.js' silently fails resolution."
        ),
        "extraction_text": (
            "requires the library id to include a leading slash, e.g. /vercel/next.js. "
            "Omitting the slash returns a bare 404 with no other diagnostic"
        ),
        "title": "Context7 library id needs a leading slash",
        "category": "gotcha",
        "severity": "high",
        "source": "context7",
    },
    {
        "text": (
            "crawl4ai's /crawl endpoint caches page renders by default; set "
            "crawler_config.params.cache_mode to BYPASS to force a fresh render of a page "
            "you have already crawled."
        ),
        "extraction_text": (
            "caches page renders by default; set crawler_config.params.cache_mode to BYPASS "
            "to force a fresh render"
        ),
        "title": "crawl4ai caches renders unless cache_mode=BYPASS",
        "category": "gotcha",
        "severity": "medium",
        "source": "crawl4ai",
    },
    {
        "text": (
            "LiteLLM's tokenTtlSeconds setting caps a token's age independently of its own "
            "exp claim; the 24h schema default silently rejects a long-lived token 24 hours "
            "after minting with a bare 401, not an expiry error."
        ),
        "extraction_text": (
            "tokenTtlSeconds setting caps a token's age independently of its own exp claim; "
            "the 24h schema default silently rejects a long-lived token 24 hours after "
            "minting with a bare 401, not an expiry error"
        ),
        "title": "tokenTtlSeconds caps token age, not just exp",
        "category": "auth",
        "severity": "critical",
        "source": "litellm",
    },
    {
        "text": (
            "Docling's DocumentConverter.convert() accepts a local path or a URL directly; "
            "there is no separate download step."
        ),
        "extraction_text": (
            "DocumentConverter.convert() accepts a local path or a URL directly; there is no "
            "separate download step"
        ),
        "title": "DocumentConverter.convert accepts a URL directly",
        "category": "usage",
        "severity": "informational",
        "source": "docling",
    },
]


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


def _call_langextract(text: str) -> typing.Any:
    """Run the live LangExtract model call. The one seam in this module that imports
    langextract, so tests can monkeypatch this function and exercise the rest of ``extract()``
    (prompt/example wiring, DocChunk mapping, char-interval grounding) without the ``extract``
    optional dependency installed.

    Talks to Cave's LiteLLM gateway (the single AI access point for every agent on the box)
    through LangExtract's OpenAI-compatible provider, the same way ``_parse_crawl4ai`` talks to
    a self-hosted service: no vendor SDK for what is one gateway.
    """
    import os

    import langextract as lx
    from langextract.factory import ModelConfig

    examples = [
        lx.data.ExampleData(
            text=ex["text"],
            extractions=[
                lx.data.Extraction(
                    extraction_class=_EXTRACTION_CLASS,
                    extraction_text=ex["extraction_text"],
                    attributes={
                        "title": ex["title"],
                        "category": ex["category"],
                        "severity": ex["severity"],
                        "source": ex["source"],
                    },
                )
            ],
        )
        for ex in _FEW_SHOT_EXAMPLES
    ]

    base_url = os.environ.get("LANGEXTRACT_BASE_URL", "http://100.78.123.100:4001/v1")
    model_id = os.environ.get("LANGEXTRACT_MODEL_ID", "openai/gpt-4o-mini")
    api_key = os.environ.get("LANGEXTRACT_API_KEY") or os.environ.get("LITELLM_AGENT_KEY", "")

    return lx.extract(
        text_or_documents=text,
        prompt_description=_PROMPT,
        examples=examples,
        config=ModelConfig(
            model_id=model_id,
            provider="openai",
            provider_kwargs={"api_key": api_key, "base_url": base_url},
        ),
    )


def _to_chunks(annotated: typing.Any, default_source: str) -> list[DocChunk]:
    """Map a LangExtract ``AnnotatedDocument`` onto the corpus's ``DocChunk`` contract.

    ``content`` is the extraction's own verbatim span (not a paraphrase): that is what keeps
    ``char_start``/``char_end`` a true index into the parsed source rather than provenance for
    text that no longer matches it. An invalid ``severity`` is not coerced here -- DocChunk's
    ``Severity`` Literal makes pydantic reject it, which is the desired behavior.
    """
    chunks: list[DocChunk] = []
    for extraction in annotated.extractions or []:
        if getattr(extraction, "extraction_class", None) != _EXTRACTION_CLASS:
            continue
        attrs = extraction.attributes or {}
        interval = extraction.char_interval
        chunks.append(
            DocChunk(
                title=attrs.get("title", extraction.extraction_text[:80]),
                content=extraction.extraction_text,
                source=attrs.get("source") or default_source,
                severity=attrs.get("severity", "informational"),
                category=attrs.get("category"),
                char_start=interval.start_pos if interval else None,
                char_end=interval.end_pos if interval else None,
            )
        )
    return chunks


def extract(parsed: ParseResult) -> list[DocChunk]:
    """Run LangExtract on parsed Markdown to produce grounded, corpus-ready DocChunks."""
    annotated = _call_langextract(parsed.markdown)
    return _to_chunks(annotated, parsed.source.vendor or "unknown")


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
