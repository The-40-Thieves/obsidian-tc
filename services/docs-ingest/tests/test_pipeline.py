"""extract() mapping onto DocChunk, char-interval grounding, and the dry-run pipeline.

The LangExtract model call is stubbed at ``pipeline._call_langextract`` -- the one seam that
imports the ``langextract`` package -- so these tests need none of the ``extract`` optional
dependency installed, matching how test_router.py/test_writer.py need none of docling/crawl4ai.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest
from pydantic import ValidationError

from obsidian_tc_docs_ingest import pipeline
from obsidian_tc_docs_ingest.contracts import ParseResult, SourceRef
from obsidian_tc_docs_ingest.pipeline import extract, ingest


@dataclass
class _FakeInterval:
    start_pos: int | None
    end_pos: int | None


@dataclass
class _FakeExtraction:
    extraction_class: str
    extraction_text: str
    attributes: dict[str, str] | None
    char_interval: _FakeInterval | None


@dataclass
class _FakeAnnotatedDocument:
    extractions: list[_FakeExtraction]


def _parsed(markdown: str) -> ParseResult:
    return ParseResult(
        markdown=markdown,
        source=SourceRef(uri="https://docs.example.com/x", vendor="acme"),
        parser="crawl4ai",
    )


def test_extract_maps_grounded_extraction_onto_doc_chunk(monkeypatch: pytest.MonkeyPatch) -> None:
    markdown = "Intro text. The widget endpoint requires an API key. Trailing text."
    start = markdown.index("The widget endpoint requires an API key.")
    end = start + len("The widget endpoint requires an API key.")

    fake = _FakeAnnotatedDocument(
        extractions=[
            _FakeExtraction(
                extraction_class="doc_fact",
                extraction_text=markdown[start:end],
                attributes={
                    "title": "Widget endpoint needs an API key",
                    "category": "auth",
                    "severity": "high",
                    "source": "acme",
                },
                char_interval=_FakeInterval(start_pos=start, end_pos=end),
            )
        ]
    )
    monkeypatch.setattr(pipeline, "_call_langextract", lambda text: fake)

    chunks = extract(_parsed(markdown))

    assert len(chunks) == 1
    chunk = chunks[0]
    assert chunk.title == "Widget endpoint needs an API key"
    assert chunk.category == "auth"
    assert chunk.severity == "high"
    assert chunk.source == "acme"
    assert chunk.char_start == start
    assert chunk.char_end == end
    # The whole point of char-interval grounding: the offsets actually index into the source.
    assert markdown[chunk.char_start : chunk.char_end] == chunk.content


def test_extract_skips_extractions_of_other_classes(monkeypatch: pytest.MonkeyPatch) -> None:
    markdown = "Some prose the model was not asked to tag."
    fake = _FakeAnnotatedDocument(
        extractions=[
            _FakeExtraction(
                extraction_class="something_else",
                extraction_text="prose",
                attributes={"title": "irrelevant", "source": "acme"},
                char_interval=None,
            )
        ]
    )
    monkeypatch.setattr(pipeline, "_call_langextract", lambda text: fake)

    assert extract(_parsed(markdown)) == []


def test_extract_falls_back_to_default_source_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    markdown = "A fact with no source attribute."
    fake = _FakeAnnotatedDocument(
        extractions=[
            _FakeExtraction(
                extraction_class="doc_fact",
                extraction_text=markdown,
                attributes={"title": "A fact"},
                char_interval=None,
            )
        ]
    )
    monkeypatch.setattr(pipeline, "_call_langextract", lambda text: fake)

    chunks = extract(_parsed(markdown))

    assert len(chunks) == 1
    assert chunks[0].source == "acme"  # SourceRef.vendor, the default_source passed through
    assert chunks[0].char_start is None
    assert chunks[0].char_end is None


def test_extract_rejects_invalid_severity_instead_of_coercing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    markdown = "A fact with a bogus severity."
    fake = _FakeAnnotatedDocument(
        extractions=[
            _FakeExtraction(
                extraction_class="doc_fact",
                extraction_text=markdown,
                attributes={
                    "title": "Bogus severity",
                    "severity": "apocalyptic",
                    "source": "acme",
                },
                char_interval=None,
            )
        ]
    )
    monkeypatch.setattr(pipeline, "_call_langextract", lambda text: fake)

    with pytest.raises(ValidationError):
        extract(_parsed(markdown))


def test_dry_run_ingest_unchanged(tmp_path: Path) -> None:
    """Regression pin: dry_run is the only working path today and tests depend on it."""
    written = ingest(
        SourceRef(uri="https://docs.example.com/x", vendor="context7"),
        tmp_path,
        dry_run=True,
    )
    assert len(written) == 1
    text = written[0].read_text(encoding="utf-8")
    assert "Dry-run placeholder for https://docs.example.com/x (parser: crawl4ai)." in text
    assert 'source: "context7"' in text
    assert "severity: informational" in text
