"""Endpoint settings for live runs: the environment first, then the setup file.

``docs-ingest setup`` writes ``$XDG_CONFIG_HOME/obsidian-tc/docs-ingest.env`` (default
``~/.config/obsidian-tc/docs-ingest.env``), dotenv-style: one ``KEY=VALUE`` per line, ``#``
comments, optional single or double quotes. ``DOCS_INGEST_CONFIG`` overrides the location.
"""

from __future__ import annotations

import os
import string
from collections.abc import Mapping
from pathlib import Path

CONFIG_ENV = "DOCS_INGEST_CONFIG"

# Values made only of these characters are written bare; anything else is double-quoted.
_BARE = frozenset(string.ascii_letters + string.digits + "_./:@+-,%")


def path() -> Path:
    """The setup file: ``DOCS_INGEST_CONFIG`` when set, else under ``$XDG_CONFIG_HOME``."""
    override = os.environ.get(CONFIG_ENV, "").strip()
    if override:
        return Path(override)
    base = os.environ.get("XDG_CONFIG_HOME", "").strip() or str(Path.home() / ".config")
    return Path(base) / "obsidian-tc" / "docs-ingest.env"


def get(name: str) -> str | None:
    """A setting from the environment, else from the setup file. Empty counts as unset."""
    value = os.environ.get(name, "").strip() or load().get(name, "").strip()
    return value or None


def load() -> dict[str, str]:
    """Every setting in the setup file; a missing file is an empty config."""
    try:
        text = path().read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    values: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = _unquote(value.strip())
    return values


def save(values: Mapping[str, str]) -> Path:
    """Replace the setup file with ``values``, created or tightened to mode 0600.

    The mode is set before the secrets are written, so the file is never readable by others,
    not even briefly, including when it already existed with looser permissions.
    """
    target = path()
    target.parent.mkdir(parents=True, exist_ok=True)
    lines = []
    for key, value in values.items():
        if "\n" in value or "\r" in value:
            raise ValueError(f"{key} must be a single line")
        lines.append(f"{key}={_quote(value)}")
    if os.name == "posix" and target.exists():
        os.chmod(target, 0o600)
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
    return target


def _quote(value: str) -> str:
    if value and set(value) <= _BARE:
        return value
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1]
    if len(value) < 2 or value[0] != '"' or value[-1] != '"':
        return value
    out = []
    chars = iter(value[1:-1])
    for ch in chars:
        out.append(next(chars, "\\") if ch == "\\" else ch)
    return "".join(out)
