"""Frontmatter rendering, slugging, and the dry-run ingest write loop."""

from __future__ import annotations

from pathlib import Path

from obsidian_tc_docs_ingest.contracts import DocChunk, SourceRef
from obsidian_tc_docs_ingest.pipeline import ingest
from obsidian_tc_docs_ingest.writer import render_markdown, write_chunk


def test_render_markdown_frontmatter() -> None:
    chunk = DocChunk(
        title="Strict Leading Slash Requirement",
        content="Always prepend the slash to /owner/repo.",
        source="context7",
        severity="critical",
        category="breaking_change",
    )
    md = render_markdown(chunk)
    assert md.startswith("---\n")
    assert 'title: "Strict Leading Slash Requirement"' in md
    assert "severity: critical" in md
    assert 'source: "context7"' in md
    assert 'category: "breaking_change"' in md
    assert md.rstrip().endswith("Always prepend the slash to /owner/repo.")


def test_write_chunk_path(tmp_path: Path) -> None:
    chunk = DocChunk(title="Token Budget", content="Use 5000.", source="context7")
    dest = write_chunk(chunk, tmp_path)
    assert dest == tmp_path / "context7" / "token-budget.md"
    assert dest.read_text(encoding="utf-8").endswith("Use 5000.\n")


def test_dry_run_ingest_writes_corpus_file(tmp_path: Path) -> None:
    written = ingest(
        SourceRef(uri="https://docs.example.com/x", vendor="context7"),
        tmp_path,
        dry_run=True,
    )
    assert len(written) == 1
    assert written[0].exists()
    assert written[0].read_text(encoding="utf-8").startswith("---\n")
