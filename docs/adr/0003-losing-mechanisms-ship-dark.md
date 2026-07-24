# Mechanisms that lose their measurement ship dark

When a retrieval mechanism fails to beat the champion on the golden set, we keep it: merged,
tested, reachable by flag, default-off, with its measured numbers recorded on the ticket. The
alternatives were deleting it (which loses the evidence and invites someone to rebuild it in
six months) and enabling it anyway (which is how unmeasured complexity accumulates).

The consequence is a codebase that deliberately contains reachable-but-off machinery, and a
reader cannot tell a dark mechanism from a bug by looking at it. Two obligations follow.
Anything default-off must say what it lost by and against which corpus. And "dark" means
reachable: a mechanism that cannot be turned on is not dark, it is broken, which is the
distinction the unreachable-mechanism defect class was found by missing.
