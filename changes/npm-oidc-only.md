---
type: Security
---
- **Releases publish to npm through OIDC only.** Every npm package now has a GitHub Actions trusted publisher for `publish.yml`, so the publish workflow no longer reads an `NPM_TOKEN` secret. A test fails if a token comes back. A brand-new package name still needs one manual first publish and `npm trust github` before CI can publish it.
