---
type: Changed
tool-description-change: find_link_cycles
---
- **`find_link_cycles` skips structural two-note loops by default.** A new `min_length` input (default 3) drops loops shorter than that many links, so a note and its folder index no longer fill the page. Pass `min_length: 2` to get the old behaviour. The result gains `skipped_shorter`.
- **`total` is the real count.** It counts every distinct cycle within the length bounds, not just the returned page. `truncated: true` means the scan hit its work cap, so `total` is then a lower bound.
- **New `folder` input.** Only notes under that folder are cycle members; edges that leave it are ignored.
