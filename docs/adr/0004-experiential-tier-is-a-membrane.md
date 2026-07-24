# The experiential tier is a separate database with no references across the boundary

Captured agent work-memory lives in its own database file beside the authored cache, on its
own migration chain, with no foreign keys reaching authored content in either direction.
Authored and experiential material meet only when a query composes them at read time.

This is deliberate over the simpler option of extra tables in the shared cache. Captured
episodes are low-trust by construction: they contain whatever passed through an agent,
including content an attacker chose. A schema-level join would make that content structurally
load-bearing for authored retrieval. Keeping the boundary physical means the failure mode of
a poisoned episode is a bad answer, not a corrupted index, and it means the tier can be
dropped wholesale without touching authored state.
