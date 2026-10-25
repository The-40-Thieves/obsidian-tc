"""Endpoint settings for live runs: the environment first, then the setup file.

``docs-ingest setup`` writes ``$XDG_CONFIG_HOME/obsidian-tc/docs-ingest.env`` (default
``~/.config/obsidian-tc/docs-ingest.env``), dotenv-style: one ``KEY=VALUE`` per line, ``#``
comments on their own line, optional single or double quotes. ``DOCS_INGEST_CONFIG`` overrides
the location.
"""

from __future__ import annotations

import os
import string
import sys
from collections.abc import Mapping
from pathlib import Path

CONFIG_ENV = "DOCS_INGEST_CONFIG"

# Values made only of these characters are written bare; anything else is double-quoted.
_BARE = frozenset(string.ascii_letters + string.digits + "_./:@+-,%")

# Names that supply a setting, in precedence order. The environment is searched in this order,
# then the setup file in this order, so the environment always beats the file.
ENV_NAMES: dict[str, tuple[str, ...]] = {
    "LANGEXTRACT_API_KEY": ("LANGEXTRACT_API_KEY", "LITELLM_AGENT_KEY"),
}

# Setup-file locations already reported as unreadable, so one run warns once per file.
_warned: set[str] = set()


def path() -> Path:
    """The setup file: ``DOCS_INGEST_CONFIG`` when set, else under ``$XDG_CONFIG_HOME``."""
    override = os.environ.get(CONFIG_ENV, "").strip()
    if override:
        return Path(override)
    base = os.environ.get("XDG_CONFIG_HOME", "").strip() or str(Path.home() / ".config")
    return Path(base) / "obsidian-tc" / "docs-ingest.env"


def env_names(name: str) -> tuple[str, ...]:
    """The environment names that supply ``name``, in precedence order."""
    return ENV_NAMES.get(name, (name,))


def get(name: str) -> str | None:
    """A setting from the environment, else from the setup file. Empty counts as unset.

    The file is only read when no environment name is set. A file that cannot be read counts as
    empty (see ``_file_values``).
    """
    names = env_names(name)
    return _first_set(os.environ, names) or _first_set(_file_values(), names)


def load() -> dict[str, str]:
    """Every setting in the setup file; a missing file is an empty config.

    Lines end at ``\\n`` only, so no other character in a value can start a new setting.
    """
    try:
        text = path().read_bytes().decode("utf-8")
    except FileNotFoundError:
        return {}
    values: dict[str, str] = {}
    for raw in text.split("\n"):
        line = raw.removesuffix("\r").strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = _unquote(value.strip())
    return values


def save(values: Mapping[str, str]) -> Path:
    """Replace the setup file with ``values``, created or tightened to mode 0600.

    Every value is checked and the whole file is encoded before the file is opened, so a refused
    or unencodable value leaves the existing file untouched. The mode is set before the secrets
    are written, so the file is never readable by others, not even briefly.
    """
    lines = []
    for key, value in values.items():
        if not value.isprintable():
            raise ValueError(f"{key} must be one line of printable text")
        lines.append(f"{key}={_quote(value)}")
    data = ("\n".join(lines) + "\n").encode("utf-8")

    target = path()
    target.parent.mkdir(parents=True, exist_ok=True)
    if os.name == "posix" and target.exists():
        os.chmod(target, 0o600)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0)
    fd = os.open(target, flags, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)
    return target


def _first_set(source: Mapping[str, str], names: tuple[str, ...]) -> str | None:
    for key in names:
        value = source.get(key, "").strip()
        if value:
            return value
    return None


def _file_values() -> Mapping[str, str]:
    """The setup file as ``get`` sees it: an unreadable or undecodable file, or an unknown home
    directory, counts as empty and prints one warning naming the file and the error class."""
    try:
        return load()
    except (OSError, UnicodeDecodeError, RuntimeError) as exc:
        where = location()
        if where not in _warned:
            _warned.add(where)
            print(
                f"docs-ingest: ignoring the setup file {where}: {type(exc).__name__}",
                file=sys.stderr,
            )
        return {}


def location() -> str:
    try:
        return str(path())
    except RuntimeError:
        return "(home directory unknown)"


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
