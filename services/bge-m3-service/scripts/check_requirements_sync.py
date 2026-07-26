"""Fail if requirements.in has drifted from pyproject.toml's runtime dependencies.

WHY THIS EXISTS. requirements.txt is a hash-verified lock of the heavy ML stack — torch,
FlagEmbedding, sentence-transformers — which CI deliberately never installs (it mocks the model
layer and installs the package --no-deps). That means nothing in CI would notice if someone added
a runtime dependency to pyproject.toml and never recompiled the lock: the lock would stay green,
stay hash-verified, and silently not describe the service any more.

This check is deliberately NOT a recompile. Recompiling would hit the network, take minutes, and
churn on every upstream release — a gate people learn to ignore. The failure mode worth catching is
structural: a dependency exists in one file and not the other.

Run:  python scripts/check_requirements_sync.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import tomllib

SERVICE = Path(__file__).resolve().parent.parent


def name_of(spec: str) -> str:
    """Normalize a requirement to its PEP 503 name: drop extras, markers, version bounds, case."""
    base = re.split(r"[<>=!~;\[]", spec, maxsplit=1)[0]
    return re.sub(r"[-_.]+", "-", base).strip().lower()


def main() -> int:
    pyproject = tomllib.loads((SERVICE / "pyproject.toml").read_text())
    declared = {name_of(d) for d in pyproject["project"]["dependencies"]}

    req_in = SERVICE / "requirements.in"
    pinned = {
        name_of(line)
        for line in req_in.read_text().splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }

    missing = sorted(declared - pinned)
    extra = sorted(pinned - declared)
    problems: list[str] = []
    if missing:
        problems.append(
            f"in pyproject.toml [project.dependencies] but NOT in requirements.in: {', '.join(missing)}\n"
            "  -> the lock does not cover a runtime dependency; add it and recompile"
        )
    if extra:
        problems.append(
            f"in requirements.in but NOT in pyproject.toml: {', '.join(extra)}\n"
            "  -> the lock pins something the package does not declare; remove it or declare it"
        )

    # A run that compared nothing would pass. Assert both sides are populated before trusting
    # a clean result — an empty parse is the failure that reads as success.
    if not declared or not pinned:
        problems.append(
            f"parsed {len(declared)} declared and {len(pinned)} pinned dependencies; "
            "one side is empty, so this check verified nothing"
        )

    if problems:
        print("requirements drift:\n" + "\n".join(f"- {p}" for p in problems), file=sys.stderr)
        return 1

    print(f"requirements.in covers all {len(declared)} runtime dependencies from pyproject.toml")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
