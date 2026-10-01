---
type: Fixed
---
- **The leader lock's replaced-file check no longer misses a replacement on Windows.** The keepalive
  compared the lock file's `stat` device and inode as plain numbers, but on Windows the inode is the
  64-bit NTFS file ID, which routinely exceeds 2^53 and is rounded by a double, so two different files
  could compare equal and a leader that had lost its lock file never demoted. The identity is now
  compared exactly (bigint). Also stops two `vault-lock` tests from timing out on windows-latest.
