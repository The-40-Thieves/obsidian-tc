---
type: Fixed
---
- **Challenge evidence now stays traceable after expanded recall and filtering.** Reflect returns every evidence chunk the judge was shown in `sources`, removes egress-excluded top-k sources before returning or logging them, and logs only returned evidence. Numbered, dot-relative, wikilink, and extensionless citations resolve only when their normalized vault-relative path exactly matches a shown path, never by basename; low coverage and `kept`/`truncated`/`contradiction_count` reflect the post-egress set; stripped evidence aliases cannot survive in a summary or finding rationale; and egress exclusion that leaves no evidence refuses instead of calling the judge.
