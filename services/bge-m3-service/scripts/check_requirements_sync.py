"""Fail if requirements.in has drifted from pyproject.toml's runtime dependencies.

WHY THIS EXISTS. requirements.txt is a hash-verified lock of the heavy ML stack — torch,
FlagEmbedding, sentence-transformers — which CI deliberately never installs (it mocks the model
layer and installs the package --no-deps). That means nothing in CI would notice if someone added
a runtime dependency to pyproject.toml and never recompiled the lock: the lock would stay green,
stay hash-verified, and silently not describe the service any more.

This check is deliberately NOT a recompile. Recompiling would hit the network, take minutes, and
churn on every upstream release — a gate people learn to ignore. The failure mode worth catching is
structural: a dependency exists in one file and not the other, OR (THE-1118 fix round) the SAME
dependency is declared with a DIFFERENT version specifier in the two files — e.g. pyproject.toml
tightens a ceiling (`huggingface-hub>=1,<2`) but requirements.in is never touched (`huggingface-hub
>=1`), so a `uv pip compile` off requirements.in resolves a version the pyproject range no longer
permits. Name-only comparison could not see that: both files agreed the package belonged, so it
reported clean while requirements.in silently allowed a wider range than pyproject.toml claims to
support.

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


def specifier_of(spec: str) -> str:
    """The version-specifier portion of a requirement line, whitespace-normalized, with any
    extras (`[standard]`), environment marker (`; python_version...`), or trailing comment
    stripped — none of those are part of the version constraint being compared. Returns "" for a
    requirement with no version constraint at all (an unbounded floor)."""
    without_extras = re.sub(r"\[[^\]]*\]", "", spec)
    m = re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]*\s*([<>=!~].*)?$", without_extras.strip())
    if not m or not m.group(1):
        return ""
    raw = re.split(r"[;#]", m.group(1), maxsplit=1)[0]
    return re.sub(r"\s+", "", raw)


def parse_requirements(lines: list[str]) -> dict[str, str]:
    """name -> specifier for every non-blank, non-comment requirement line (or pyproject.toml
    dependency string — both are the same PEP 508 requirement-line shape)."""
    return {
        name_of(line): specifier_of(line)
        for line in lines
        if line.strip() and not line.lstrip().startswith("#")
    }


def sync_problems(declared: dict[str, str], pinned: dict[str, str]) -> list[str]:
    """Pure comparison of pyproject.toml's declared runtime deps against requirements.in's
    pinned ones: what's missing, what's extra, and (THE-1118 fix round) which names are present
    in both but with a DIFFERENT version specifier — the drift a name-only set comparison cannot
    see. Injectable so it is testable with no filesystem, mirroring
    check-bun-version-coherence.mjs's `bunVersionProblems` shape."""
    problems: list[str] = []
    missing = sorted(set(declared) - set(pinned))
    extra = sorted(set(pinned) - set(declared))
    mismatched = sorted(name for name in set(declared) & set(pinned) if declared[name] != pinned[name])

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
    if mismatched:
        lines = "\n".join(
            f'  {name}: pyproject.toml has "{declared[name] or "(unbounded)"}", '
            f'requirements.in has "{pinned[name] or "(unbounded)"}"'
            for name in mismatched
        )
        problems.append(
            "version specifier differs between pyproject.toml and requirements.in:\n"
            f"{lines}\n"
            "  -> a range change in one was not mirrored in the other; keep them identical"
        )

    # A run that compared nothing would pass. Assert both sides are populated before trusting
    # a clean result — an empty parse is the failure that reads as success.
    if not declared or not pinned:
        problems.append(
            f"parsed {len(declared)} declared and {len(pinned)} pinned dependencies; "
            "one side is empty, so this check verified nothing"
        )

    return problems


def main() -> int:
    pyproject = tomllib.loads((SERVICE / "pyproject.toml").read_text())
    declared = parse_requirements(pyproject["project"]["dependencies"])

    req_in = SERVICE / "requirements.in"
    pinned = parse_requirements(req_in.read_text().splitlines())

    problems = sync_problems(declared, pinned)

    if problems:
        print("requirements drift:\n" + "\n".join(f"- {p}" for p in problems), file=sys.stderr)
        return 1

    print(f"requirements.in covers all {len(declared)} runtime dependencies from pyproject.toml")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
