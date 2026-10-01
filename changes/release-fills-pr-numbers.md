---
type: Changed
---
- **Release notes no longer need their PR number in the fragment.** `scripts/release.mjs` now fills `(#N)` into the end of each `changes/*.md` fragment's first bullet from git history (the `Merge pull request #N` commit that brought the fragment in, or a trailing `(#N)` on a squash commit), so a PR no longer commits its own number after opening and re-runs its verification. A fragment that already cites `(#N)` is left as written, a release whose fragment has no determinable PR refuses and names the file, and the release needs full history (`git fetch --unshallow`).
