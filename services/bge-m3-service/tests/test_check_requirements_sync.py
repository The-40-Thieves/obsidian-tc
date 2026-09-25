"""scripts/check_requirements_sync.py: name AND version-specifier comparison (THE-1118 fix
round). `scripts/` is not part of the installed package, so the module is loaded by file path
rather than imported normally — the same reason `sys.path` tricks show up nowhere else in this
test suite. Every function under test is pure (no filesystem), matching
check-bun-version-coherence.test.mjs's injected-dependency shape on the TypeScript side.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_MODULE_PATH = Path(__file__).resolve().parent.parent / "scripts" / "check_requirements_sync.py"
_spec = importlib.util.spec_from_file_location("check_requirements_sync", _MODULE_PATH)
check_requirements_sync = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = check_requirements_sync
_spec.loader.exec_module(check_requirements_sync)

name_of = check_requirements_sync.name_of
specifier_of = check_requirements_sync.specifier_of
parse_requirements = check_requirements_sync.parse_requirements
sync_problems = check_requirements_sync.sync_problems


def test_specifier_of_extracts_a_simple_range():
    assert specifier_of("sentence-transformers>=5,<6") == ">=5,<6"


def test_specifier_of_strips_extras_before_looking_for_the_specifier():
    assert specifier_of("uvicorn[standard]>=0.51") == ">=0.51"


def test_specifier_of_drops_an_environment_marker():
    assert specifier_of('foo>=1; python_version >= "3.10"') == ">=1"


def test_specifier_of_drops_a_trailing_comment():
    assert specifier_of("foo>=1  # pinned for X") == ">=1"


def test_specifier_of_is_empty_for_an_unbounded_requirement():
    assert specifier_of("numpy") == ""


def test_specifier_of_normalizes_internal_whitespace():
    assert specifier_of("foo >= 1, < 2") == ">=1,<2"


def test_parse_requirements_builds_a_name_to_specifier_map():
    result = parse_requirements(["FlagEmbedding>=1.4", "", "# comment", "numpy>=2"])
    assert result == {"flagembedding": ">=1.4", "numpy": ">=2"}


def test_sync_problems_reports_nothing_when_specifiers_match():
    declared = {"huggingface-hub": ">=1,<2", "sentence-transformers": ">=5,<6"}
    pinned = {"huggingface-hub": ">=1,<2", "sentence-transformers": ">=5,<6"}
    assert sync_problems(declared, pinned) == []


def test_sync_problems_catches_a_mismatched_specifier_on_a_name_present_in_both():
    # This is the exact pre-fix-round shape: pyproject.toml tightened huggingface-hub to a <2
    # ceiling but requirements.in still declared the old unbounded ">=1" — a name-only
    # comparison sees "huggingface-hub" in both sets and calls it clean.
    declared = {"huggingface-hub": ">=1,<2", "sentence-transformers": ">=5,<6"}
    pinned = {"huggingface-hub": ">=1", "sentence-transformers": ">=5,<6"}
    problems = sync_problems(declared, pinned)
    assert len(problems) == 1
    assert "huggingface-hub" in problems[0]
    assert '">=1,<2"' in problems[0]
    assert '">=1"' in problems[0]
    assert "sentence-transformers" not in problems[0]


def test_sync_problems_still_catches_missing_and_extra_names():
    declared = {"a": ">=1", "b": ">=2"}
    pinned = {"a": ">=1", "c": ">=3"}
    problems = sync_problems(declared, pinned)
    assert len(problems) == 2
    assert any("NOT in requirements.in: b" in p for p in problems)
    assert any("NOT in pyproject.toml: c" in p for p in problems)


def test_sync_problems_existence_floor_when_one_side_is_empty():
    problems = sync_problems({}, {"a": ">=1"})
    assert any("one side is empty" in p for p in problems)


def test_requirements_in_and_pyproject_are_actually_in_sync_on_disk():
    """The regression this whole fix round exists for: run the real parse against the real
    files, not fixtures — this is what would have failed pre-fix (requirements.in still said
    `huggingface-hub>=1` / `sentence-transformers>=5` while pyproject.toml already had the `<2`
    / `<6` ceilings)."""
    service = _MODULE_PATH.parent.parent
    import tomllib

    pyproject = tomllib.loads((service / "pyproject.toml").read_text())
    declared = parse_requirements(pyproject["project"]["dependencies"])
    pinned = parse_requirements((service / "requirements.in").read_text().splitlines())
    assert sync_problems(declared, pinned) == []
