---
type: Added
---
- **Test coverage is now published, not just measured.** The server suite already enforced coverage thresholds but wrote only a human-readable summary, so the code-quality services that report on pull requests had no file to read and showed no coverage at all. The suite now also writes an `lcov` report, and continuous integration uploads it.
