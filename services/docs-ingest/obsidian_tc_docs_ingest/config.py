"""Endpoint settings for live runs: the environment first, then the setup file.

``docs-ingest setup`` writes ``$XDG_CONFIG_HOME/obsidian-tc/docs-ingest.env`` (default
``~/.config/obsidian-tc/docs-ingest.env``), dotenv-style: one ``KEY=VALUE`` per line, ``#``
comments on their own line, optional single or double quotes. ``DOCS_INGEST_CONFIG`` overrides
the location.
"""

from __future__ import annotations

import contextlib
import os
import string
import sys
import tempfile
from collections.abc import Iterable, Mapping
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


def save(values: Mapping[str, str], remove: Iterable[str] = ()) -> Path:
    """Write the setup file: ``values`` set or added, ``remove`` keys dropped, and every other line
    (comments, keys this tool does not manage) kept in its place.

    Every value is checked and the whole file is built before anything is written, so a refused
    value leaves the existing file untouched. The new text goes to a 0600 temp file in the same
    directory, is flushed to disk, then swapped over the old file; a failure removes the temp file
    and leaves the old one as it was. The secrets are never readable by others, not even briefly.
    """
    updates = {}
    for key, value in values.items():
        if not value.isprintable():
            raise ValueError(f"{key} must be one line of printable text")
        updates[key] = f"{key}={_quote(value)}"
    dropped = set(remove)

    # A symlink is resolved first, so the swap replaces the real file and the link stays in place.
    target = Path(os.path.realpath(path()))
    kept: list[str] = []
    written: set[str] = set()
    for raw in _read_lines(target):
        key = _key(raw)
        if key is None:
            kept.append(raw)
        elif key in updates:
            if key not in written:
                kept.append(updates[key])
                written.add(key)
        elif key not in dropped:
            kept.append(raw)
    kept += [line for key, line in updates.items() if key not in written]
    data = ("\n".join(kept) + "\n").encode("utf-8")

    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=target.parent, prefix=f".{target.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, target)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temp)
        raise
    _sync_directory(target.parent)
    return target


def _read_lines(target: Path) -> list[str]:
    """The setup file's lines as written, without their line feeds (a carriage return stays with its
    line, so a kept line is copied exactly); none if the file is missing."""
    try:
        text = target.read_bytes().decode("utf-8")
    except FileNotFoundError:
        return []
    lines = text.split("\n")
    if lines[-1] == "":
        lines.pop()
    return lines


def _sync_directory(directory: Path) -> None:
    """Flush the swap's directory entry to disk. Skipped where a directory cannot be opened."""
    flag = getattr(os, "O_DIRECTORY", None)
    if flag is None:
        return
    try:
        fd = os.open(directory, os.O_RDONLY | flag)
    except OSError:
        return
    try:
        with contextlib.suppress(OSError):
            os.fsync(fd)
    finally:
        os.close(fd)


def _key(line: str) -> str | None:
    """The setting a line assigns, or None for a comment, a blank line or anything ``load`` skips."""
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in stripped:
        return None
    return stripped.partition("=")[0].strip()


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
