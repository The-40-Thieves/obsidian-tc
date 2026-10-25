"""``python -m obsidian_tc_docs_ingest <command>``, the same as the ``docs-ingest`` script."""

from .cli import main

if __name__ == "__main__":
    raise SystemExit(main())
