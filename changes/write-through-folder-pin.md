---
type: Security
---
- **Note writes honour a configured symlinked folder.** A write into a folder reached through its
  symlink (`wiki -> pages`), such as `write_note` or `commit_wiki_page`, was refused as a symlinked
  path component even though reads and deletes already followed the pin. It now lands in the folder
  the symlink points at. A write named by the target's own spelling is also verified against the pin,
  so it can no longer overwrite or create a file in a directory swapped in after the access decision.
  A native addon that predates pinned writes refuses such a write rather than writing unpinned. The
  folders a write creates under a pinned folder are now made inside the verified walk, so a folder
  swapped in after the access decision gets none, and a pinned folder moved away is not re-created.
  A failed batch removes the folders it made under the pin. A native addon that predates pinned
  folder creation refuses a write that would create folders under a pin.
