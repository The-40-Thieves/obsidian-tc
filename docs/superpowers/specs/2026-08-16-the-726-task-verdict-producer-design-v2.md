# THE-726 — the task-verdict producer, v2

**Status:** design, not built. **Date:** 2026-08-16. **Ticket:** THE-726.
**Supersedes:** `2026-08-15-the-726-task-verdict-producer-design.md`, which was **rejected** by cross-vendor review. That file is kept, not deleted — the review is the most useful artefact this design has produced, and a rejected draft with its refutation attached is worth more than a clean file with no history.

---

## 0. What the review found, and what survived

A Codex refutation pass (framed to *refute*, not extend) returned **reject**: seven blocking findings and five internal contradictions. Three were independently re-verified against `main` `611d6e34` before being accepted; one of Codex's claims contradicted something *this author* had asserted from a partial source, and Codex was right.

**The two decisions the owner made survive unchanged.** The session is the task (D1) and a stamp closes the open window (D2). Neither is what broke.

**What broke was everything underneath:** the exclusion mechanism, the queue's closure proxy, the interaction with eligibility ordering, the stamp's own footprint, the evidence weighting, and the cross-database write in the `end_session` passthrough.

| # | finding | status | fixed in |
| --- | --- | --- | --- |
| 1 | The stamping verb's own dispatch row lands *after* its UPDATE, so every stamp strands one unstamped row and reopens the window | confirmed | §4.2, §4.3 |
| 2 | `reflect.ts:136`'s hold is order-dependent: a late `-1` arrives after promotion and never fires | confirmed | §4.5 |
| 3 | The window UPDATE has a semantic TOCTOU race against concurrent dispatch | confirmed | §4.4 |
| 4 | `pending_verdict` ≠ closure — the sweep is **age**-based, not idle-based | confirmed | §4.6 |
| 5 | One judgment becomes N evidence lines; sampling weight is dispatch count | confirmed | §4.7 |
| 6 | `tool NOT LIKE '%/%'` is lexical inference, not structure — and the spec **permits** `/` | confirmed | §4.3 |
| 7 | `end_session(task_result)` reintroduces the cross-database write | confirmed | §4.8, THE-838 |

### The claim that was wrong, and whose it was

v1 asserted the MCP spec forbids `/` in tool names, citing `server/tools.mdx`. **SEP-986 in the same repository explicitly allows it:**

> Allowed characters: uppercase and lowercase ASCII letters, digits, underscore (`_`), dash (`-`), dot (`.`), and **forward slash (`/`)**. … Allow for **hierarchical and namespaced tool names** (e.g., using `/` and `.`).
> Example valid tool names: `getUser`, **`user-profile/update`**, `DATA_EXPORT_v2`, `admin.tools.list`

So `user-profile/update` is a documented, spec-valid tool name that v1's filter would have silently excluded from judgment forever. One page was read and reported as the spec's answer. §4.3 is rebuilt on that.

## 1. The measurement

Production store, `/data/llm-stack/obsidian-tc/cache/experiential.db`, re-derived 2026-08-16T03:17Z.

> Query that path directly. The `obsidian-tc-experiential` MCP handle points at `~/.obsidian-tc/experiential.db`, frozen 2026-07-31 with the pre-rename `outcome` column. It fails loudly on `task_result` and answers **silently and wrongly** on anything touching only columns both generations share.

| | |
| --- | --- |
| `agent_episodes` | **630** rows, 32 distinct tools, 3 callers |
| with `session_id` | **265** across **55** sessions |
| `task_result` / `summary` non-NULL | **0** / **0** |
| dispatches per session | **4.82** (range 1–18) |
| gap-segments per session (>5 min) | **1.36**; 69.1% of sessions are one burst |
| MCP protocol methods | **192 / 630 = 30.5%** |
| `workspace_sessions` (cache.db) | **56**, all `caller IS NULL` (implicit), all closed |

Two facts the ticket still does not carry: **client adoption already happened** (attach 255/255 = 100% since 2026-08-05), and the grain contradiction is written into `20260806_003`'s own justification (*"an episode IS the task"*) while `episodes.ts:89` writes one row per **dispatch**.

## 2. Decisions

| # | decision | status |
| --- | --- | --- |
| **D1** | The **session is the task**; the verdict projects onto that window's judgeable rows. | owner, stands |
| **D2** | A **stamp closes the open window**, which then reopens. | owner, stands |
| **D3** | A new `work_result` verb + a `task_result` passthrough on `end_session`. | stands; passthrough now **blocked on THE-838** |
| **D4** | **Event kind becomes structural.** The producer writes `episode_type` honestly; nothing downstream infers kind from a name. | new, v2 |
| **D5** | The queue is **debt-age**, not closure. It says so in its name. | new, v2 |
| **D6** | A `-1` stamp **demotes** the rows it stamps back to `pending`, so the hold rule is order-independent. | new, v2 |
| **D7** | `(session_id, verdict_at)` is the **window identity**, and every consumer must dedupe on it. | new, v2 |

## 3. Scope change — split out as THE-839

**The producer's `episode_type` must be fixed first.** v1 scoped that out and tried to work around it with a string filter; findings #1 and #6 are both consequences of that choice, and every workaround is a variant of the refuted filter.

**Split into THE-839 on 2026-08-16, at the owner's call**, with a `blocks` edge onto THE-726 so the dependency is a real graph edge rather than a sentence in a design doc. THE-839 owns the `DispatchEpisode.kind` field, the `episodes.ts` write, the one-time backfill, and the `channel` decision.

It is split because it is **independently valuable**: 30.5% of live rows are mislabelled today, and that is wrong whether or not the verdict producer is ever built. It is a blocker because **v2 has no correct exclusion predicate until `episode_type` is true** — §4.3 is a one-line filter precisely because THE-839 does the work.

The `verdict` tag ships in THE-839 with **no consumer yet**; this design is its consumer. That is deliberate, so the producer changes once rather than twice.

> **Corrected 2026-08-16 during THE-839's implementation:** this document originally spelled the judgeable kind `"tool"`. It ships as **`"tool_call"`** — the value `episode_type` already held for real tool calls. Renaming it would have churned 438 correct rows and ten test fixtures for no reader's benefit, and the defect was never the spelling; it was protocol methods borrowing the value. Every predicate below reads `episode_type = 'tool_call'`.

## 4. Design

### 4.1 Data model

`workspace_sessions` (cache.db) and `agent_episodes` (experiential.db) are **different SQLite files**, with separate migration chains and **no `ATTACH` anywhere in the codebase**. Nothing is added to `workspace_sessions`; the projection is the only storage.

One migration, experiential chain:

```sql
ALTER TABLE agent_episodes ADD COLUMN verdict_at INTEGER;   -- ms epoch of the stamp
```

`task_result` already exists and is unchanged. `verdict_at` is **not** telemetry — see §4.7, it is half the window identity, and without it the projection is uninterpretable.

**On the objection that "projection" renames a semantic mistake rather than removing it:** correct as stated, and this is the answer. The column is row-grain; the judgment is window-grain. `(session_id, verdict_at)` is what makes the row-grain column interpretable — it recovers exactly which rows share one judgment. A consumer that ignores it *does* double-count (§4.7). The pair is therefore mandatory, not advisory, and §4.7 makes it a gate rather than a note.

### 4.2 The producer tells the truth about event kind (D4)

`DispatchEpisode` (`registry/types.ts:265`) carries no operation-kind field, and `episodes.ts:94` hardcodes `channel='dispatch', episode_type='tool_call'` for **every** captured operation. That is why 192 protocol methods are labelled `tool_call`.

```
DispatchEpisode gains:  kind: "tool_call" | "protocol" | "verdict"
episodes.ts writes it to episode_type instead of the literal.
```

The registry knows which it is — it dispatched it. `kind` is derived at the dispatch site, never re-inferred downstream:

- `"protocol"` — an MCP method (`tools/list`, `prompts/list`, `resources/list`), not a registered tool.
- `"verdict"` — a registered tool carrying the `verdict` tag. Today: `work_result`, `end_session`. Derived from the registry's existing `tags` array, so adding a third verdict verb needs no edit here — the same registry-derived closed-set pattern THE-837 established.
- `"tool_call"` — everything else. **This is the judgeable set.** The existing spelling is kept: it was always correct for a real tool call, and renaming would rewrite 438 correct rows and ten test fixtures to say the same thing differently. The defect was protocol methods borrowing the value, not the value.

**Historical rows.** 192 existing rows are mislabelled. One backfill, in the migration:

```sql
UPDATE agent_episodes SET episode_type = 'protocol' WHERE tool LIKE '%/%';
```

The `/` heuristic is legitimate **here** and illegitimate as a runtime predicate, and the difference is not stylistic: this runs once, over a closed set of 630 rows that were inspected before it was written, on a corpus where the only two slash-bearing names are known protocol methods. A standing predicate makes the same guess about names that do not exist yet — including `user-profile/update`, which SEP-986 blesses. **Bounded retrodiction over an inspected set is not the same operation as unbounded prediction over an open one.**

### 4.3 The exclusion (fixes #1, #6)

```sql
AND episode_type = 'tool_call'
```

That is the whole filter. No name matching anywhere.

It fixes #1 by construction: `work_result`'s own dispatch row is `episode_type='verdict'`, so it is never a judgment target and cannot strand itself or contaminate the next window. It fixes #6 by construction: a tool named `user-profile/update` is `kind: "tool_call"` and is judged, because kind comes from the dispatcher rather than from spelling.

**Gate:** no SQL or TypeScript on the verdict path may match a provider- or tool-*name* pattern to decide judgeability. Source-scan, floored on finding the projection statement at all — a gate that scans nothing reports success.

### 4.4 The window, and its honest estimand (fixes #3)

```sql
UPDATE agent_episodes
   SET task_result = :result, verdict_at = :now
 WHERE session_id    = :session
   AND task_result IS NULL
   AND episode_type  = 'tool_call'
   AND ts           <= :as_of;
```

The UPDATE is atomic; **the agent's judgment is not formed atomically with it.** A dispatch committed between the agent deciding and the statement executing is swept into the verdict. v1 claimed stamping per task *"partitions the session exactly"*. That claim is false under concurrent dispatch and is withdrawn.

The estimand is stated instead of overclaimed:

> **A stamp applies to every judgeable row in this session with no verdict and `ts <= as_of`.** It is not a claim about the agent's conceptual task boundary, because the server cannot observe one.

`as_of` defaults to now and is caller-settable, so an agent that *does* know its boundary can pin it. The residual error is bounded by the dispatches an agent issues concurrently with its own stamp — which, for a client that stamps between tasks rather than during one, is zero.

### 4.5 A `-1` demotes (fixes #2)

`evaluateEpisodes` selects `WHERE eligibility = 'pending'` (`reflect.ts:152`) and promotes to `'eligible'` (`:170`). **Nothing ever re-inspects a promoted row.** So a `-1` arriving at session close lands after promotion, `held_bad_task_result` never fires, and a failed task's episodes stay retrievable. v1's claim that "both readers keep working unchanged" was false for this reader.

The stamp therefore demotes what it marks bad:

```sql
-- in the same transaction as the UPDATE above, when :result = -1
UPDATE agent_episodes
   SET eligibility = 'pending', eligibility_reason = NULL, eligibility_policy = NULL
 WHERE session_id = :session AND verdict_at = :now AND eligibility = 'eligible';
```

The next evaluator pass re-inspects and applies the hold, with its reason recorded (THE-746). Demotion is consistent with the existing model: a *held* row already keeps `eligibility='pending'` (`reflect.ts:173`), so "pending" already means "not yet promoted", not "never seen".

Only `-1` demotes. A `0` or `+1` verdict changes no promotion decision, and demoting on every stamp would re-run the evaluator over the entire corpus for no verdict change.

### 4.6 The queue is debt-age, not closure (fixes #4)

v1 claimed idleness was *"the same rule applied on the same clock"* as `closeStaleImplicitSessions`. It is not, and the function's own docblock says so three lines above its SQL:

> **A WINDOW, not an idle timeout.** … An idle timeout needs a `last_activity_at` column and a write on every request; a window needs neither.

The sweep is `started_at < cutoff` — age from session **creation** — and it only runs on the maintenance cadence, so closure lags further still (measured in production: a session created at 12:34 was still open at 13:21). Session-level `MAX(ts)` idleness diverges from that in four ways, including one that is actively dangerous: repeated `resources/list` chatter keeps a session's `MAX(ts)` fresh and can **indefinitely hide** old unstamped rows from the queue.

So the queue stops pretending to detect closure and measures what it can actually see — **per-row debt age**:

```sql
SELECT * FROM agent_episodes
 WHERE task_result IS NULL
   AND episode_type = 'tool_call'
   AND ts < :now - :windowSeconds * 1000;
```

Per-row, so chatter cannot hide anything: a protocol row is not judgeable and never enters, and a stale tool row ages on its own clock regardless of what else the session is doing. It shares `windowSeconds` with the sweep because that is the operator's stated "a session is over by now" horizon, not because it detects the same event.

**Named for what it is.** `pending_verdict` implied closure; the surface is `unstamped_debt`, and the docs say it measures *judgeable work older than the session window with no verdict* — which is the thing an agent can act on, and is true whether or not the session closed.

### 4.7 Window identity is mandatory (fixes #5)

`extractPreferences` (`reflect.ts:350`) selects individual rows, omits `session_id` and `verdict_at`, and formats each as an independent evidence line (`:372`), capped at `maxEvidence = 40`.

Projecting one judgment onto N rows therefore spends N of 40 evidence slots on one observation. Measured against this corpus: **~8 distinct judgments** would fill the 40-row budget, and an 18-dispatch task outweighs a 1-dispatch task **18:1** for the same single verdict. That is a length bias, not a quality signal, and it biases learned preferences toward tool-heavy workflows.

This is not philosophical. It lands hardest on **THE-673 — the ticket this design exists to unblock** — whose premise is *"replace LLM preference extraction with **counters** over typed evidence."* A counter reads 4.82 correlated rows as 4.82 independent observations.

Requirements, both binding:

1. `extractPreferences` selects `session_id, verdict_at` and collapses each window to **one** evidence line, carrying the member count as context rather than as repetition.
2. **THE-673's counters MUST group by `(session_id, verdict_at)`.** Recorded on that ticket, not only here — a requirement stated only in a superseded design is a requirement nobody reads.

The external literature agrees this direction is the weak one: outcome-level rewards *"cannot identify which intermediate memory contents support the final answer"* ([AttriMem, arXiv 2607.21106](https://arxiv.org/abs/2607.21106v1)), and step-level attribution consistently outperforms it. **We are choosing the weaker signal deliberately**, because the binding constraint here is adoption, not attribution quality — two finer-grained affordances have already measured 0 (THE-718's 0/108, THE-633's 0 rows). A precise scheme nobody calls is worth less than a coarse one that gets stamped. D2's window preserves the grouping, so a later refinement (weighting by position, or by whether a dispatch's result was cited) is not foreclosed.

### 4.8 `end_session` passthrough — ordering, and a blocker (fixes #7)

The passthrough must write to both files, which cannot share a transaction. Ordering is specified rather than left to chance:

1. **Stamp experiential.db first.**
2. **Then close cache.db.**

A crash between leaves the session open with its episodes stamped: recoverable, because subsequent dispatches attach to the still-open session and surface as debt. The reverse order leaves a permanently closed session with unstamped episodes and no path back — unrecoverable. The existing `end_session` already carries a third non-transactional effect (the JSONL append, `session-tools.ts:205`); the trace append stays first, since a trace entry for a session that then fails to close is inert.

> **BLOCKED: the passthrough must not ship before THE-838.** `end_session` never checks `s.principal === ctx.caller`, so any principal with `write:workspace` on the vault can end another's session. Adding a verdict passthrough upgrades that from *closing your session* to *stamping verdicts onto your episodes*. `work_result` (D3) is unaffected and can ship first — it resolves its session through `activeSessionFor`, which is keyed on the server-observed principal.

### 4.9 API

```
work_result(result: -1|0|+1, as_of?: number)
```

`note` is **removed** from v1's signature. The migration and UPDATE gave it nowhere to go, so the API would have accepted caller data and silently discarded it. If a rationale string is wanted, it needs a column and its own decision; `summary` is not it (that column has its own missing producer).

Errors: no open session → `invalid_input` naming `start_session`, never a silent no-op. Empty window → success with `stamped: 0`. Another principal's session → refuse (`activeSessionFor`, server-observed principal). Out-of-range result → schema-rejected.

## 5. Testing

- **Self-capture** — `work_result` twice with no intervening work: the second reports `stamped: 0`. Under v1 it reported 1, stamping the first call's own bookkeeping row. This is the regression test for #1 and it **fails on v1's design**.
- **Verdict-verb exclusion** — after a stamp, no `episode_type='verdict'` row carries a `task_result`.
- **Slash-named tool is judged** — a tool named `a/b` (SEP-986-valid) is `kind: "tool_call"` and receives the verdict. Fails on v1's filter.
- **Late `-1` demotes** — promote to `eligible`, then stamp `-1`, then run the evaluator: the row is held with `eligibility_reason='held_bad_task_result'`. Fails without §4.5.
- **Chatter cannot hide debt** — an old unstamped tool row plus fresh `resources/list` traffic in the same session still appears in `unstamped_debt`. Fails under v1's `MAX(ts)`.
- **Window partition** — stamp, dispatch, stamp differently: two groups, two verdicts, distinct `verdict_at`.
- **`as_of` pins the boundary** — a row committed after `as_of` is not swept in.
- **Evidence dedup** — one window of N rows yields **one** evidence line, not N.
- **Backfill** — after migration, all 192 historical protocol rows are `episode_type='protocol'` and no `tool` row was reclassified.

## 6. Acceptance

Row counts over HTTP after a real deploy, never handler registration (constraint 3). **Corrected from v1, which required a `workspace_sessions.task_result` column that §4.1 does not add — an acceptance query that could not have succeeded.**

- `agent_episodes.task_result` non-NULL on **new** episodes, with `verdict_at` set
- no `episode_type IN ('protocol','verdict')` row carries a `task_result`
- `extractPreferences` returns >0 evidence lines, and **fewer lines than stamped rows** — the direct observable for §4.7
- `unstamped_debt` **drains** at least once, which v1 could not have achieved: its queue was non-empty by construction

The kill condition starts **on deploy of this change**. It has never started; there has never been a writer (`doctor/column-spec.ts:77` still reads `writer: "none"`).

## 7. Cost

Larger than v1, and the increase is the scope change in §3.

- **Tool surface 162 → 163.** Moves `REGISTERED_TOOL_COUNT`, the facade domain map, and `boot.tools_registered` (`tol: 0`, and `perf` is push-to-main only, so **adding this tool cannot fail the PR that breaks the baseline** — re-record via `perf-baseline.yml` and commit **all four** artifact files). `work_result` mutates and names no caller-controlled vault path, so it needs a documented `EXEMPT_NO_PATH` entry, not a `pathAcl`.
- **One migration** (experiential chain): `verdict_at` + the backfill. Append the `.sql`, register in `db/migration-manifest.ts`, regenerate `migrations-embedded.ts`, then **`just migration-impact`** — 62 test files hand-build their own chain and only 16 read the manifest.
- **Producer change**: `DispatchEpisode.kind` through `dispatch-observability.ts` into `episodes.ts`.
- **Reader change**: `extractPreferences` dedupe (§4.7).
- **One new gate**: no name-pattern judgeability (§4.3).

## 8. Out of scope

- `agent_episodes.summary`, still readers-and-no-writer.
- Server-side task segmentation (rejected in v1, still rejected).
- THE-673 itself, which unblocks on this — but §4.7's grouping requirement must be written onto that ticket.
- THE-838, filed separately, blocking only D3's passthrough.

## 9. Open

1. ~~§3's scope increase~~ — **resolved: split as THE-839**, which now `blocks` THE-726. Not an open question; a sequencing constraint.
2. **NULL-principal sessions** (THE-838) — whether NULL means "anyone may close" or "only an unauthenticated transport may". Affects `work_result`'s ownership check too, so it must be decided on THE-838 before either verb ships, not discovered twice.
3. **`as_of` ergonomics** — a caller with no clock discipline passing a skewed value stamps the wrong set. Server-side clamping to `[session.started_at, now]` is the obvious guard and is not yet specified. Note `session.started_at` lives in **cache.db** (§4.1), so the clamp cannot read it from the projection's own transaction — clamp to `[MIN(ts) of the session's episodes, now]` instead, or accept the unclamped value and say so.

## 10. Sequencing

```
THE-839  episode_type becomes true          ──blocks──┐
THE-838  end_session ownership              ──blocks──┤
                                                      ▼
                                        THE-726  this design
                                                      │
                                                      ▼
                                        THE-673  counters, grouping on
                                                 (session_id, verdict_at)
```

THE-838 blocks only D3's `end_session` passthrough. **`work_result` can ship without it** — it resolves its session through `activeSessionFor`, which is keyed on the server-observed principal and therefore already carries the property `end_session` is missing.
