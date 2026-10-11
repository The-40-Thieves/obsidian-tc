---
type: Security
---
- **A real release publish requires a signed release tag, and the container image is signed before its public tags move.** A manual `publish.yml` dispatch with `dry_run` off from a branch now fails in `verify-tag` and never reaches a publishing job, and every publishing job also requires a tag ref. A branch dispatch with `dry_run` on still works. The GHCR image is signed and verified by digest before `:<version>` and `:latest` are promoted, in `publish.yml` and in `release-image.yml`, and `release-image.yml` refuses to build from a tag whose signature does not verify.
