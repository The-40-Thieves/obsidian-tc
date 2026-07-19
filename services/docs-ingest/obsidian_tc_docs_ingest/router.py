"""The parse-router: dispatch a source to the parser suited to its file type."""

from __future__ import annotations

from .contracts import ParserKind, SourceRef

# PDFs and Office documents go to Docling (layout + table fidelity).
_DOCLING_SUFFIXES = frozenset(
    {".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"}
)
# Already-clean text is passed through unparsed.
_PASSTHROUGH_SUFFIXES = frozenset({".md", ".markdown", ".txt"})
# Web markup goes to Firecrawl (JS rendering + crawl).
_WEB_SUFFIXES = frozenset({".html", ".htm"})


def _suffix(uri: str) -> str:
    tail = uri.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    dot = tail.rfind(".")
    return tail[dot:].lower() if dot > 0 else ""


def select_parser(source: SourceRef) -> ParserKind:
    """Route by file type first, then by URL scheme.

    A remote PDF (``https://.../x.pdf``) still routes to Docling: fetch, then parse for
    layout. A web page routes to Firecrawl. Markdown/txt is passed through. An unknown local
    file falls back to Docling (best-effort structured parse).
    """
    lowered = source.uri.lower()
    suffix = _suffix(lowered)
    if suffix in _DOCLING_SUFFIXES:
        return "docling"
    if suffix in _PASSTHROUGH_SUFFIXES:
        return "passthrough"
    if lowered.startswith(("http://", "https://")) or suffix in _WEB_SUFFIXES:
        return "firecrawl"
    return "docling"
