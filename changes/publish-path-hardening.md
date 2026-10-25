---
type: Changed
---
- **Release pipeline: the SBOM tool and the publish installs are pinned and checked.** The image SBOM step downloads a pinned syft release tarball and checks its sha256 before extracting it, instead of piping a remote install script to `sh`. The publish jobs that hold OIDC tokens install dependencies with `--ignore-scripts`. The Smithery publish script escapes line breaks and a leading `::` in every server response it logs. No runtime or published-package behaviour changes.
