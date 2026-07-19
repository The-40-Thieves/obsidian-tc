"""Wire contracts for the docs-ingest pipeline (pydantic only, no parse/extract deps)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Severity = Literal["informational", "medium", "high", "critical"]
ParserKind = Literal["docling", "firecrawl", "passthrough"]


class SourceRef(BaseModel):
    """A doc source: a URL or a local file path, plus an optional vendor label."""

    uri: str = Field(min_length=1)
    vendor: str | None = None


class ParseResult(BaseModel):
    """Clean Markdown produced from a source, tagged with the parser that made it."""

    markdown: str
    source: SourceRef
    parser: ParserKind


class DocChunk(BaseModel):
    """One self-contained, retrievable doc fact: the LangExtract output unit.

    Mirrors the retired KB's proven schema (title/content/category/severity/source) plus
    char offsets for provenance (LangExtract char_interval grounding).
    """

    title: str = Field(min_length=1)
    content: str = Field(min_length=1)
    source: str = Field(min_length=1)
    severity: Severity = "informational"
    category: str | None = None
    char_start: int | None = None
    char_end: int | None = None
