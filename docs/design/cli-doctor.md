# CLI Doctor

Extracted from inline commentary, 2026-08-21. The code carries the invariants; this note carries the history and evidence.

## `probeDenseProvider` (THE-688 fix 2)

Encodes one short fixed string. That is the smallest call that exercises the whole path an
operator cares about: config resolution, credential lookup, network reach, and a response the
adapter can parse. A cheaper check (a TCP connect, a HEAD on the base URL) would have passed for
the failure this closes — Ollama's container was simply gone, but a wrong model name or a missing
API key look identical to a reachability test and are just as fatal.

Goes through the SHARED `createQueryEncoder` rather than calling `provider.embed([...])` directly.
Two reasons, and the architectural gate in `query-encoder.test.ts` enforces the first: a second
single-query encode in the tree is exactly what THE-622 consolidated away. The second is that it
makes this a better probe — it exercises the same path retrieval actually takes, including the
`input: "query"` asymmetric-prefix handling, so a provider that answers batches but breaks on
query-shaped input is caught rather than missed.

Deliberately uses the SYNC `createEmbeddingProvider`, not the async one: the sync factory refuses
`provider: "module"` with an actionable error, so doctor's "never execute operator-supplied code"
rule holds BY CONSTRUCTION rather than through a special case here that could drift away from it.

## `probeNotesFts` (THE-696)

Opens `cache.db` READ-WRITE, which is required: FTS5 exposes integrity-check as an INSERT into the
virtual table, so a read-only handle cannot run it. It writes nothing — the command only reads the
inverted index and reports — and WAL mode means this is safe alongside a running server.

`ensureNotesFts` is called first because availability and soundness are different questions and
conflating them is the whole ticket: an adapter without FTS5 must report "off", not "malformed".
The availability flag is returned alongside the verdict so the check can tell those two cases
apart.

## `probeEpisodeBacklog` (THE-698)

Counts rather than evaluates: diagnosing must never promote a row. Reports the oldest pending
episode's AGE alongside the count because the count alone cannot discriminate — episodes captured
since the last tick are supposed to be pending, and "6 pending" is healthy while "337 pending,
oldest 17 days" means the evaluator has never run. Both are non-zero numbers.

Reads only — it issues a single `GROUP BY` and writes nothing. The path is passed PLAIN, not as a
`file:...?mode=ro` URI: `openDatabase` hands the string straight to `bun:sqlite`, which treats a
URI as a literal filename, so the read-only form silently opened the wrong file and the catch
block turned that into "not probed" against a live store with 337 pending rows. The `existsSync`
guard is what keeps a fresh install from having an empty `experiential.db` conjured by the probe.

## `probeDerivedTables` — writer classification and the THE-629 correction

The classification is the load-bearing part of `derived.liveness` — a row count alone cannot
distinguish "this feature is switched off" from "this feature is on and has never worked", and
only the second is a finding. Each entry pairs the count with whether anything is in a position to
write it IN THIS deployment, derived from the same config the server boots from.

**THE-629, corrected 2026-08-04.** `memory_entities` and `memory_relations` were originally
classified `writer: "none"`, with a lever asserting the writer was absent — the ticket's own
unverified premise, propagated into the health surface. It was false. `memory/entities.ts:97` and
`:164` ARE the writers, and five registered MCP tools reach them — `create_entity`, `get_entity`,
`add_observation`, `link_entities`, `query_entity_graph`. Nothing was missing except a caller,
which is the same situation as `workspace_sessions`.

The distinction is not cosmetic: `none` stays a FINDING, while `on-demand` is reported and never
warned on ("a feature awaiting its first use"). So doctor was warning about a missing writer that
was not missing, and pointing anyone who investigated at building one that already existed.

Genuinely on-demand, and unlike sessions there is no server-side alternative: the server can
observe that a principal is active, but "this concept named X of type Y matters" is a judgement it
cannot make. The archived G2.1 design specifies `create_entity` as a caller-supplied verb and
defers retrieval fusion to V2; no ingest-time producer was ever designed, and none exists.

The tables are now classified `on-demand`, with levers "a client calling `create_entity`
(THE-629)" and "a client calling `link_entities` (THE-629)" respectively.

## `probeDerivedTables` — `workspace_sessions` (THE-726)

`workspace_sessions` is a client- and user-driven surface: `enabled` means the verb is registered
and reachable; empty means the verb has never been exercised, which is the finding. THE-726
widened the lever beyond "a client": with `sessions.autoOpen`, the server opens a session itself on
a principal's first authenticated dispatch, which is why this table stopped being empty on
2026-08-04. It is still classified `on-demand` — off by default, and nothing writes it unasked.

## `probeDerivedColumns` (THE-720)

Samples the signal-bearing columns for `derived.column-liveness`: total rows, non-NULL rows,
distinct non-NULL values, one aggregate per column. The row count is re-read per column rather than
cached per table because a missing column must degrade to "skip this entry" and not to "this table
has no rows", which would report every OTHER column on that table as inconclusive.

## `probeKbHealth` (THE-722)

This is the reader `audit_reports` never had. The table held 301 rows in production — one every ~8
minutes since the job shipped — and nothing in the tree selected from it outside its own test, so
both liveness checks called it `live` while no operator could see a single report.

## `probeEntryPoints` — two traps (THE-715, THE-716)

Reads the scheduler's own durable state (`job_schedule`) and the tool-invocation census
(`agent_episodes`), both already written by the running server, so this reads truth rather than
deriving it.

1. `job_schedule.name` is a TEXT PRIMARY KEY, and SQLite does not enforce NOT NULL on one, so every
   UPSERT carrying a null name INSERTED instead of updating — **2,979 orphan rows against 6 real
   ones (THE-715)**. Filtering on `name IS NOT NULL` is not defensive coding here; without it the
   pass list is 99.8% noise. The orphan count is reported, not warned on: the named rows update
   correctly and the defect is already ticketed.
2. The tool-invocation census is a LOWER BOUND and `null` means NOT MEASURED. Episode capture is
   per-caller and `captureEpisodes` can be off, so coercing an absent measurement to 0 would present
   "capture is off" as "no tool was ever called" — a failure encoded as a valid result.

`job_runs` history (THE-716) is read in its own `try` so a store without the `job_runs` table still
reports the schedule state above; `runs` stays `null` when the table is absent, because
not-measured and measured-zero are different facts and the check renders them differently.
