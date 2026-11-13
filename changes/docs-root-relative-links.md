---
type: Fixed
---
- **Two docs links work on the hub site.** The storage-state and auth-model pages linked each other with `../../` paths, which the 40 Thieves hub does not rewrite when it serves the site under `/reliquary-tc`. They are root-relative now, and the docs build refuses any new `./` or `../` link.
