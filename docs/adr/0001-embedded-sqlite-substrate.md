# Embedded SQLite is the substrate, not Postgres

obsidian-tc's predecessor kept its index in Postgres with pgvector, and the converged engine
was originally scoped to carry that forward. We chose embedded SQLite (with sqlite-vec as an
optional extension) as the default and only shipped substrate instead, because the product is
a thing you run beside your own vault, and a server that requires a database to be provisioned
before it can answer a question is not that thing.

Postgres is not forbidden, it is unbuilt. A storage-backend abstraction is the V2 path if a
hosted deployment ever needs it. Until then, no code should assume a network database is
reachable, and no design should be rejected for being awkward under Postgres.
