---
type: Fixed
---
- **Inline-code scanning no longer allocates an object per backtick span.** `inlineCodeRanges` (behind `extractLinks`, `rewriteLinks` and `extractInlineTags`) now returns a flat list of span bounds from an `indexOf` loop instead of a `matchAll` match array plus a tuple per span. On a multi-megabyte line of backtick spans the old shape pushed the heap into GC promotion and scan time stepped up about 2.5x per size doubling (measured on macOS CI), which failed the linear-scaling test intermittently. Same spans, same results, about half the time on Linux at 2 MB.
