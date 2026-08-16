# THE-726 — the task-verdict producer

**Status:** design agreed, not built. **Date:** 2026-08-15.
**Ticket:** THE-726 (EPIC: client lifecycle coordinator).
**Supersedes nothing.** Extends the 2026-08-10 decision `task_result is stamped by the acting agent, with the session-close sweep making the debt visible` — that named the *emitter*; this names the *unit* it writes to, which the epic left open.

---

## 1. What this closes

THE-726's constraint 1 asked who stamps `agent_episodes.task_result`, and the 2026-08-10 decision answered: **the acting agent stamps, with a session-close sweep making the debt visible.**

A second question was raised in review and never answered:

> an episode is one *dispatch*, a task spans many — decide the unit before writing the producer.

Until that is settled the producer cannot be written, because "stamp the episode" has two incompatible meanings.

## 2. The measurement

All figures re-derived from the **production** store on **2026-08-16T03:17Z**
(`/data/llm-stack/obsidian-tc/cache/experiential.db`).

> Query the production path directly. The `obsidian-tc-experiential` MCP handle points at
> `~/.obsidian-tc/experiential.db`, frozen 2026-07-31, still carrying the pre-rename `outcome`
> column. It fails loudly on `task_result` but would answer *silently and wrongly* on any query
> touching only columns both schema generations share — row counts, caller mix, attach rate.

| | |
| --- | --- |
| `agent_episodes` | **630** rows, 32 distinct tools, 3 callers |
| with `session_id` | **265** |
| `task_result` non-NULL | **0** |
| `summary` non-NULL | **0** |
| sessions | **55** |

**Two facts that move the epic:**

**(a) Client adoption already happened.** The epic's outstanding item 2 reads *"something must actually call `start_session`; still nothing does it."* Since 2026-08-05 the attach rate is **255/255 = 100%**. PR #691/#692's HTTP session wiring works and clients took it up on their own. That blocker is closed and the ticket does not know.

**(b) The grain contradiction is written into the schema.** Migration `20260806_003` justifies keeping the column with:

> an episode IS the task, so "how did the task go" has a coherent denominator here — **one row, one task, one verdict**.

But `episodes.ts:89` says *"One insert per **dispatch** outcome"*, and all 630 rows are `channel='dispatch'`, `episode_type='tool_call'`. The rename fixed the `status`-vs-`outcome` conflation and left a second one standing: **one row is one dispatch, not one task.**

### Span, which is what the decision hangs on

| | |
| --- | --- |
| dispatches per session | **4.82** (range 1–18) |
| segments per session, splitting on a >5 min gap | **1.36** (75 segments / 55 sessions) |
| sessions that are a single burst | **38 / 55 = 69.1%** |
| sessions with >1 burst | **17 / 55 = 30.9%** (one has four) |
| protocol chatter (`prompts/list`, `resources/list`) | **192 / 630 = 30.5%** overall; **88 / 265 = 33.2%** of session-bound |

### Both readers consume at *dispatch* grain

- `reflect.ts:136` — holds **this row** out of promotion when `task_result = -1` (`held_bad_task_result`).
- `reflect.ts:352` — preference-extraction evidence, formatting **each row** as one item: `episode task_result=+1 tool=X status=Y`.

Neither wants "did the task succeed". Both want "was **this call** part of something that worked" — a dispatch-grain attribution of a task-grain judgment.

### There is no writer

`doctor/column-spec.ts:77` reports `writer: "none"`, lever *"no producer exists"*. `record_retrieval_feedback` writes `chunk_retrievals.feedback`, a different table.

## 3. Decisions

| # | decision |
| --- | --- |
| **D1** | **The session is the task.** One verdict per session-window, **projected down** onto that window's dispatch rows, so both `reflect.ts` readers keep working unchanged. The projection is the only storage — see §4.1 for why there is no session-grain column. |
| **D2** | **A stamp closes the open window.** It applies to every unstamped episode in the session so far, then the window reopens. |
| **D3** | **A new `work_result` verb**, plus an optional `task_result` passthrough on the existing `end_session`. |

**Why D1 over a new task grain or a per-dispatch verdict.** A `work_tasks` table is the most faithful model — a task genuinely is neither a session nor a call — but it needs boundaries the server cannot observe, so the agent must declare start *and* end. That is a third affordance, and two have already gone unadopted (THE-718's tool-description affordance: 0/108; THE-633's goals: 0 rows). Redefining `task_result` as a per-dispatch verdict is honest about the row grain and matches both readers exactly, but it puts adoption cost at one stamp per call — precisely the shape `record_retrieval_feedback` already measured at **0/108**.

D1 costs one stamp per ~4.8 dispatches and rides a session-close hook that already fires in production.

**Why D2.** D1 alone smears one verdict across the 30.9% of sessions holding more than one burst. D2 fixes that without inventing a boundary: an agent that stamps once at close covers everything; an agent that stamps after each task partitions the session exactly. Nothing is stored that can drift, and an agent that stamps zero times leaves the window open — which is the debt state the queue must see.

The rejected alternative was server-side segmentation on an idle gap. The 5-minute threshold used in §2 is an **analysis** constant chosen to describe the data; promoting it to a **behavioural** one would manufacture task boundaries no agent thought of, and re-partition already-stamped history whenever it changed.

## 4. Design

### 4.1 Data model — and the constraint that shapes it

**`workspace_sessions` and `agent_episodes` are in different databases.** `workspace_sessions` is created by `20260519_001_initial.sql` in **cache.db**; `agent_episodes` and `chunk_retrievals` are in **experiential.db** (`20260711_002`, `20260626_001`). Two files, two migration chains (`db/provision.ts` and `cli.ts`), and **no `ATTACH` anywhere in the codebase** — the two are never joined.

> This corrects the first draft of this design, which put `task_result` and `verdict_at` on `workspace_sessions`. That straddles both files: the verdict write and the projection write could not share a transaction, so a crash between them would leave a session stamped with its episodes unstamped, or the reverse. Worse, §4.4's queue predicate would have needed a cross-database read that has no precedent here.

**The projection IS the record.** Nothing is added to `workspace_sessions`, and the session-grain verdict is derived where anyone needs it:

```sql
SELECT DISTINCT task_result FROM agent_episodes WHERE session_id = ? AND task_result IS NOT NULL;
```

One migration, in the experiential chain only:

```sql
ALTER TABLE agent_episodes ADD COLUMN verdict_at INTEGER;  -- ms epoch of the stamp
```

`task_result` already exists (renamed from `outcome` by `20260806_003`) and is **unchanged as a column**, newly **written by projection**. No new table, no FK, no cross-database write, no reader change.

This also keeps the change inside the derived plane rather than reaching into the authored one, which is the boundary THE-563/564 established.

`verdict_at` earns its column: `task_result IS NULL` already separates unjudged from neutral-judged (`0`), but `verdict_at` gives the stamp-to-dispatch latency the kill condition is measured in, and distinguishes a live stamp from a later backfill.

`doctor/column-spec.ts` must flip `task_result` from `writer: "none"` to a named writer, and the entry must say **projected from a session-grain verdict**, not *stamped per row*. A future reader treating it as an independent per-dispatch judgment would be wrong, and the spec entry is where that gets said.

### 4.2 Window semantics

```sql
UPDATE agent_episodes
   SET task_result = :result, verdict_at = :now
 WHERE session_id  = :session
   AND task_result IS NULL      -- the open window
   AND tool NOT LIKE '%/%';     -- the exclusion, see 4.3
```

`task_result IS NULL` **is** the window. There is no window state to store and none to drift.

### 4.3 The exclusion is structural, not a denylist

A hardcoded chatter list rots. The discriminator is already in the data: every MCP protocol method carries a `/`; none of the 30 registered tool names does.

| | count | share |
| --- | --- | --- |
| `prompts/list` | 106 | |
| `resources/list` | 86 | |
| **protocol methods** | **192** | **30.5%** |
| registered tools (30) | 438 | 69.5% |

So the filter is `tool NOT LIKE '%/%'`, and it is self-maintaining. **It requires a test asserting the two families stay disjoint**, so a future tool named with a slash cannot silently opt itself out of judgment.

Recorded, not fixed here: those 192 rows are stored as `episode_type = 'tool_call'`, which they are not. Pre-existing mislabel, own ticket.

### 4.4 The debt queue — deviation from a recorded decision

The 2026-08-10 decision says `closeStaleImplicitSessions` **marks** unstamped episodes `pending_verdict`. This design **derives** it instead — and per §4.1 it must derive it **without reading cache.db**, since `ended_at` lives there and nothing joins the two files:

```sql
-- entirely within experiential.db
SELECT e.* FROM agent_episodes e
  JOIN (SELECT session_id, MAX(ts) AS last_ts
          FROM agent_episodes WHERE session_id IS NOT NULL
         GROUP BY session_id) s USING (session_id)
 WHERE e.task_result IS NULL
   AND e.tool NOT LIKE '%/%'
   AND s.last_ts < :now - :windowSeconds * 1000;
```

Idleness stands in for closure, using **the same `windowSeconds`** `closeStaleImplicitSessions` already takes. That is not an approximation of session closure so much as the same rule applied on the same clock: that sweep closes an implicit session precisely when it has been idle that long.

Two properties this buys over the stored mark:

- A stored mark is a second thing that can be wrong, and this epic exists because of columns written once that then diverged from the truth. A derived predicate cannot go stale and needs no migration of its own.
- It removes the cross-database read the stored version would have required, since the marking sweep runs against cache.db while the rows to mark are in experiential.db.

`work_episodes(filter: "pending_verdict")` reads the same predicate. `idx_agent_episodes_session` covers the grouping.

**This is a deviation from a recorded decision and is flagged as one.** Reverting to a stored mark is possible but now costs more than it did in the first draft: it needs a column, a migration, and a sweep that writes across the file boundary.

### 4.5 Surfaces

```
NEW     work_result(result: -1|0|+1, note?: string)
        -> stamps the open window; the window reopens
        -> callable at any point in a session

EXTEND  end_session(task_result?: -1|0|+1)
        -> same projection, at close
```

The mid-session verb is what makes D2 actually partition. Without it an agent wanting two verdicts must close and reopen a session, and D2 collapses back into D1's smear.

### 4.6 Error handling

- **No open session** → `invalid_input`, naming `start_session`. Never a silent no-op: a silent no-op here is a third thing that reads 0.
- **Window already empty** (every episode stamped) → success, `stamped: 0`. Idempotent by construction; re-stamping is not an error, it is a no-op the caller can see.
- **Session belongs to another principal** → refuse. `activeSessionFor` already resolves on the server-OBSERVED `ctx.caller`, not the caller-declared column — PR #691's security property, and this verb must not become the hole in it.
- **Out-of-range result** → schema-rejected at the tool boundary; the column is `-1|0|+1`, not free-form.

## 5. Testing

- **Projection**: N unstamped dispatches + 1 stamp → all N carry the verdict; chatter rows do not.
- **Window**: stamp, dispatch more, stamp again → the two groups carry *different* verdicts. This is the D2 test and it fails on a naive whole-session UPDATE.
- **Idempotence**: two stamps, no work between → second reports `stamped: 0`, first group unchanged.
- **Exclusion disjointness**: registered tool names and protocol methods share no `/` convention. Guards 4.3 against a future slash-named tool.
- **Reader integration**: `reflect.ts:352`'s evidence set returns >0 rows after a stamp — the whole point, and the only test that catches the projection landing somewhere the readers do not look.
- **Cross-principal**: principal B cannot stamp principal A's session.

## 6. Acceptance

Per the epic's constraint 3, this closes on **row counts over HTTP after a real deploy**, never on handler registration:

- `workspace_sessions.task_result` non-NULL on ≥1 session
- `agent_episodes.task_result` non-NULL on **new** episodes
- `reflect.ts:352`'s evidence set returns >0 rows

**The kill condition starts on deploy of this change.** It has never started, because there has never been a writer. If `pending_verdict` is non-empty and `task_result` is still 0 two weeks after deploy, agent-stamps has failed twice with two affordances and the disposition flips to elicitation or to `on-demand`.

## 7. Cost

**Tool surface 162 → 163.** Per CLAUDE.md that moves `REGISTERED_TOOL_COUNT`, the facade domain map, and `boot.tools_registered`. `work_result` mutates, so it also needs `pathAcl` or a documented `EXEMPT_NO_PATH` entry — it names no caller-controlled vault path, so the exemption is the right answer *with a comment saying why*.

`boot.tools_registered` is `tol: 0`, and `perf` runs push-to-main only and is not required, so **adding this tool cannot fail the PR that breaks the baseline**. Re-record via `gh workflow run perf-baseline.yml` and commit **all four** artifact files — copying `baseline.small.json` without its provenance sidecar is refused as a hand-edit (THE-754).

**One migration, experiential chain.** Append the `.sql`, register it in `db/migration-manifest.ts`, regenerate `migrations-embedded.ts`. Then the fourth step nothing gates: **`just migration-impact <file>.sql`**. 62 test files hand-build their own literal migration chain and only 16 read the manifest, so a new migration leaves the rest behind and you find them one red CI build at a time. That cost three rounds on 2026-08-06.

## 8. Out of scope

- Deleting or re-typing the 192 mislabelled protocol-method episodes.
- `agent_episodes.summary`, which also has readers and no writer. Fixing only `task_result` activates a low-evidence preference learner; that is accepted here and stays THE-726's problem, not this design's.
- Server-side task segmentation (§3, rejected).
- THE-673, which unblocks on this but is its own ticket.

## 9. Open

**Nothing blocks implementation.** Two items are flagged for the reviewer rather than assumed:

1. **§4.4 derives `pending_verdict` where the 2026-08-10 decision stored it.** Deliberate, reversible, small.
2. **§4.3's `'%/%'` filter** is derived from today's 32 tool names. It is guarded by a test, not by a registry constraint — a tool named with a slash would be excluded from judgment and the test is what catches it.
