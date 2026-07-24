# One cache.db for the server, vault isolation by row

The server opens exactly one cache database for all registered vaults, and isolation between
vaults is logical: rows carry a vault id and queries filter on it. The obvious alternative,
one database file per vault, was rejected for the v1.x line because it multiplies open
handles, migration runs, and cross-vault query cost for a benefit that row scoping already
delivers.

The cost is that isolation is now an invariant the code must maintain rather than one the
filesystem enforces for free. Every table that can hold vault-attributable data needs its
scoping argued explicitly, and the exceptions (indexes keyed only by chunk id) must scope in
the join instead. A reader who assumes physical separation will write a leak. Per-vault
database files behind a storage-backend abstraction remain the planned V2 rewrite.
