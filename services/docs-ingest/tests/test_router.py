"""Parse-router dispatch by file type and URL scheme."""

from __future__ import annotations

import pytest

from obsidian_tc_docs_ingest.contracts import SourceRef
from obsidian_tc_docs_ingest.router import select_parser


@pytest.mark.parametrize(
    ("uri", "expected"),
    [
        ("https://docs.example.com/guide", "firecrawl"),
        ("http://example.com/page.html", "firecrawl"),
        ("/local/manual.pdf", "docling"),
        ("https://example.com/whitepaper.pdf", "docling"),
        ("C:\\docs\\report.docx", "docling"),
        ("notes/gotchas.md", "passthrough"),
        ("readme.txt", "passthrough"),
        ("/data/unknown.bin", "docling"),
    ],
)
def test_select_parser(uri: str, expected: str) -> None:
    assert select_parser(SourceRef(uri=uri)) == expected
