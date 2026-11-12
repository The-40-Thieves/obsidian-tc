"""Emit a DocChunk as a Markdown file with YAML frontmatter into the corpus vault."""

from __future__ import annotations

import json
import re
from pathlib import Path

from .contracts import DocChunk

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slug(text: str) -> str:
    slug = _SLUG_RE.sub("-", text.lower()).strip("-")
    return slug or "doc"


def render_markdown(chunk: DocChunk) -> str:
    """Render the chunk as frontmatter + body. String values are JSON-encoded (valid YAML)."""
    lines = [
        "---",
        f"title: {json.dumps(chunk.title)}",
        f"severity: {chunk.severity}",
        f"source: {json.dumps(chunk.source)}",
    ]
    if chunk.category is not None:
        lines.append(f"category: {json.dumps(chunk.category)}")
    if chunk.char_start is not None and chunk.char_end is not None:
        lines.append(f"char_interval: [{chunk.char_start}, {chunk.char_end}]")
    lines += ["---", "", chunk.content, ""]
    return "\n".join(lines)


def write_chunk(chunk: DocChunk, corpus_dir: Path) -> Path:
    """Write the chunk under ``corpus_dir/<source>/<title-slug>.md`` and return the path."""
    dest = Path(corpus_dir) / _slug(chunk.source) / f"{_slug(chunk.title)}.md"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(render_markdown(chunk), encoding="utf-8")
    return dest
