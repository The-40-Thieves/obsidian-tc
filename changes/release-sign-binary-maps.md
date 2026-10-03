---
type: Fixed
---
- **Release signing counts each standalone binary's sourcemap separately.** The release pipeline signs every shipped file, and the binary glob also matched each binary's `.map` sourcemap, so the draft-release check counted 10 binary signatures where it expects 5 and refused to publish the release. Sourcemaps are now signed under their own family, pinned at 5.
