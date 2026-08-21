# Runtime: durable job-queue wiring

Extracted from inline commentary, 2026-08-21. The code carries the invariants; this note carries the history and evidence.

## Boot composition order (WP5.2, issue 16)

`plane-wiring.ts` is `run_serve`'s job-queue / job-handler / reconcile-runner / plane-schedule
wiring, extracted verbatim out of `cli.ts`. Two pieces here are deliberately constructed ahead of
their conceptual home in the boot sequence:

- `createJobQueue` runs before `tool-wiring.ts`'s `health` tool is registered, because
  `server_health`'s `getJobQueueStats` accessor closes over that *same* `JobQueue` instance —
  `server-runtime.ts` owns the actual composition order and must keep this ahead of the health
  registration.
- `createOnIndexedHook` is a factory (not a single closure) because `indexing-wiring.ts`'s
  `wireIndexCoordinator`, M1's `indexVault`, and this file's own `createReconcileRunner` all need
  the same `(vaultId) => IndexHook | undefined` shape, bound to one `jobQueue`/`roles` pair.

## Durable job queue (#14)

The contradiction/synthesis/audit jobs used to run on an in-memory queue that silently dropped
work under backpressure. `#14` replaced it with the durable `JobQueue`/`makeJobRunner` pair backing
this whole file, so a burst of index writes or a slow gateway degrades to retries and backlog
rather than lost jobs.

## Modal cold-start timeout, and the replaceIfFailed/replaceIfTerminal correction

The `bgRoles` construction in `wireJobHandlers` (giving synthesis/audit jobs a longer per-attempt
gateway budget than the interactive seam) and the `replaceIfFailed` vs `replaceIfTerminal` choice
in `registerPlaneSchedule`'s period-keyed enqueues are both corrections with full measured
histories already recorded in `CHANGELOG.md`:

- Cold-start budget, more-attempts-not-longer-timeout, and the rejected `ping()`-based pre-warm
  idea (LiteLLM `/health` measured at 60.8s across 470 models spanning 9 providers): THE-700, #659.
- The per-attempt timeout knob (`gatewayTimeoutMs`) and the 370.4s-twice-12ms-apart measurement
  that showed a deterministically slow request, not a varying cold start: THE-709, and
  `docs/wiki/Configuration.md` / `docs/src/content/docs/configuration/config-reference.md`
  (`plane.gatewayTimeoutMs`).
- `replaceIfTerminal` silently re-running completed weekly/daily work (`audit_reports` going from
  2 writes/day to 243) and the narrower `replaceIfFailed` fix: THE-723, #687.

Do not re-derive these numbers from scratch when touching this code again — check the CHANGELOG
entries above first.

## `planeGatedRoles` gate (THE-822, #788)

Before THE-822, disabling the plane (`plane.enabled: false`) stopped the scheduled consolidation
pass but not the per-index-write contradiction enqueue or the contradiction/synthesis/audit handler
registration — so with any gateway configured, a *disabled* plane still ran unattended per-chunk LLM
calls on every index write across the whole vault. `planeGatedRoles()` is the single gate every
plane-scoped consumer in this file must route through instead of reading `deps.roles` directly.
Full narrative: CHANGELOG.md, THE-822 (#788).

## Citation pass: the four gating conditions (THE-717, #708/#709/#707)

`wireJobHandlers`' citation-job registration requires all four of `experientialOpen`,
`citationInfer.enabled`, a configured `transcriptIndex`, and `roles` (a gateway/judge) before
registering the handler. Before this landed, the citation pass had exactly one caller — the offline
CLI — and on the live deployment every citation column was NULL on 105 of 105 live rows: "the pass
never ran" and "the pass ran and stamped nothing" were indistinguishable observations.

Each of the four conditions rules out a specific way the job could look scheduled while doing
nothing or doing active harm:

- `experientialOpen` — `chunk_retrievals` is where the pass reads and writes.
- `citationInfer.enabled` — it's opt-in.
- `transcriptIndex` — the real gate. With no producer there is no input, and a handler with no
  possible input is worse than an absent one: it reports success with zero work forever.
- `roles` (gateway/judge) — not merely "matches the contradiction job's gate". Without a judge the
  pass runs stage-1-only and stamps every survivor `cited_in_response = 1` with state `candidate`.
  That counts as a citation in `chunk_access_stats`, and `note_quality` weights citation rate at
  0.6 — so an unattended stage-1-only schedule would inflate 60% of every quality score with rows
  no judge ever read. A human can still choose that mode deliberately at the CLI.

## Episode evaluation scheduling (THE-698, #648)

`registerNoteQualitySchedule` wires `registerEpisodeEvaluation` (the evaluator that promotes
`pending` episodes to `eligible`) onto the maintenance cadence. Before THE-698 this pass had no
scheduled caller — only the manual `obsidian-tc reflect` CLI — and on the live deployment 337 of 337
episodes sat `pending` across seventeen days. `work_search`, which by contract serves only eligible
rows, returned zero rows every time: the capture half of the experiential tier worked, the recall
half was dark, and an honest-empty result was indistinguishable from "nothing matched".

No judge is threaded into this registration, and that is not a degraded mode: the judge can only
lower a deterministic promotion, never raise one, so the deterministic layer is the whole job. Wire
`judge` here if that invariant changes.

## The recurring "no scheduled caller" pattern, and the goal-expiry sweep (THE-633, #675)

`registerNoteQualitySchedule`'s `goal-expiry` registration lands in the same change that adds the
`goals` table, deliberately so. THE-698's evaluator, THE-717's citation pass, and THE-719's gap
sweep all shared one shape before their fixes: correct code, complete tests, no scheduled caller,
and therefore invisible from inside the repo — nothing failed loudly, the feature simply never ran
in production. A `goals` table whose expiry sweep never ran would have silently become a list of
things the user gave up on, biasing every downstream read toward stale intent.

The sweep itself runs directly (not enqueued through the job queue): it's a single bounded `UPDATE`
over one indexed predicate, with no gateway dependency and nothing that can fail halfway, so the
durable-retry machinery the job queue provides buys nothing here.
