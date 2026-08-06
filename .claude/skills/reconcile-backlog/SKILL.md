---
name: reconcile-backlog
description: Reconcile the whole open Linear backlog against HEAD, upstream state, and the decision record — a batch wrapper around verify-ticket-premise that adds external-gate checks, blocker-edge auditing, a disposition taxonomy, and an on-disk ledger so the pass survives compaction.
---

# reconcile-backlog

`verify-ticket-premise` verifies **one** ticket before you implement it. This is the batch form: it
reconciles the entire open backlog and decides what each ticket *is*, not whether to code it.

Three things it adds that the single-ticket skill does not cover:

1. **External gates.** Many tickets here wait on third-party state — a package version, a spec
   revision, a model's availability. The premise skill only reads this repo, so an upstream gate
   that opened (or a claim that it opened) is invisible to it. On 2026-08-04 a reconciliation
   asserted sqlite-vec 0.1.10 had shipped; it had not, and one `npm view` refuted it.
2. **Blocker edges.** `blockedBy` is the least reliable field on a ticket here. Blockers close
   without their dependents being revisited, so a "blocked" ticket is frequently startable. Note
   that most edges in this backlog are **prose, not the field** — see the grammar rule in Stage 2,
   which is what makes this stage work at all.
3. **An on-disk ledger.** A 40+ ticket pass will outlive its context window. Verdicts written to
   disk as you go make the pass resumable and stop you re-deriving what you already proved.

## The ordering rule

**Cheapest disqualifier first.** Most tickets are resolved without reading code:

```
blocker edge   ->  grep the body for a FORWARD-POINTER verb, then one API read on what it names
                   (state alone discriminates nothing — 31 of 34 cited tickets are already Done)
upstream gate  ->  one npm view / context7 / web check
already shipped ->  one grep for the CAPABILITY (not the ticket's identifier)
coordinates    ->  scripted file:line resolution
central claim  ->  the expensive one; only for what survives the above
```

Never start with the expensive step. Never start with the title.

## Stage 0 — Ledger

Write every open ticket to a ledger file with `disposition: null`. Every stage appends. This is the
artifact, not your context.

## Stage 1 — Fetch and extract (mechanical)

`get_issue` with `includeRelations: true`. **Read the whole body plus the newest correction banner
— the banner usually supersedes the body below it.** Write the body to disk, then extract:

- every `path/file.ts:NNN` coordinate
- every backticked symbol, table, column, config key, CLI flag
- every numeric claim (counts, ratios, row totals, versions)
- `blockedBy` / `blocks` edges
- any third-party package, spec, or model name

Then drop the body from context. It is on disk.

## Stage 2 — Mechanical verification (scripted, no judgement)

Per coordinate, resolve to **EXACT / MOVED / GONE**. A structural refactor silently invalidates
every ticket citing the files it touched, and no gate catches it because tickets are not code —
`cli.ts` went 1256 → 113 lines and five tickets still cited lines 381, 793, 855, 1300.

Resolve them with the parser, not with `rg`:

```bash
just where <Symbol>          # DECLARED / USED / PROSE-ONLY; exit 1 when nothing declares it
```

**PROSE-ONLY is the bucket that decides absence claims.** A backlog pass reads dozens of "X does
not exist" assertions, and this repo's comments discuss deleted symbols by name. A grep that finds
the obituary reports the corpse as alive.

### Blocker edges: the state is not the finding — the GRAMMAR is

Reading the blocker's current state is necessary and **nowhere near sufficient**. Measured
2026-08-06 over the whole open backlog: **31 of the 34 tickets cited by open tickets are Done.**
A sweep that flags "cites a closed ticket" therefore flags almost everything and discriminates
nothing.

Mature backlogs cite closed work constantly, and legitimately. Classify by how the sentence *uses*
the reference:

| grammar | example | verdict |
|---|---|---|
| **historical attribution** | "THE-310 exists because `vault_edges` had no `vault_id`" | correct — leave it |
| **provenance** | "shipped in #675, cited in that release's CHANGELOG" | correct — leave it |
| **forward pointer** | "blocked on THE-222", "pending THE-296", "waits on someone taking X" | **defect once closed** |

Only the third is a stale edge. Grep for the *verbs*, not the ids:

```bash
rg -i 'blocked (on|by)|pending|waits? on|gated on|until .*THE-[0-9]|prerequisite' <body-on-disk>
```

Three instances of exactly this shipped undetected until 2026-08-06 — THE-296 cited as live in the
README (it had closed by *de-scoping that very README*), THE-675 on THE-671, and THE-222 on both
THE-642 and THE-647. Each rendered as a valid link, so nothing flagged them. **A closed ticket cited
as a forward pointer reads as "work someone will get to" when the truth is "nobody owns this"** —
and those need opposite decisions, which is why the distinction is worth a stage.

A caution when building the closed-set oracle: `list_issues state=Done limit=N` returns exactly `N`
with `hasNextPage: true`, and unioning two orderings did **not** close it (250 -> 285, still
paginated). So it is one-directional — **presence proves Done; absence proves nothing.** Never
render a "not closed" verdict from it.

## Stage 3 — External gates (context7 + web)

Only for tickets whose gate is not ours to control. Record the check **and its date** on the ticket,
so the next pass re-checks rather than re-litigates.

- package currency: `npm view <pkg> dist-tags` — an alpha is not a release
- library/API semantics: context7 (`npx ctx7@latest library` then `docs`)
- spec revisions, upstream issues, competitor claims: web search

## Stage 4 — Judgement (per ticket, priority order)

Apply `verify-ticket-premise` steps 4–5 to what survived. Search by **capability, not by the
ticket's identifier** — work often ships under a different name than the ticket asking for it.

## Stage 5 — Disposition

| verdict | meaning | action |
|---|---|---|
| `CLOSE-SHIPPED` | the capability exists and is reachable | close, cite file:line |
| `CLOSE-DECIDED` | a decision note already answered it | close, cite the note |
| `CLOSE-FALSE` | premise refuted | close, record the refutation |
| `RESCOPE` | part shipped, remainder real | correct the body, keep open |
| `UNBLOCK` | blocker edge stale | drop the edge, note it is startable |
| `GATED-CONFIRMED` | external gate re-verified shut | record check + date |
| `GATED-OPEN` | gate has opened | promote |
| `FIX-NOW` | small defect exposed while verifying | fix in-process |
| `KEEP` | premise holds, correctly open | leave |

## Stage 6 — Act

**Defects found while reconciling are fixed in process, not filed.** Filing a ticket for a
five-line fix converts work into inventory. Batch them into themed PRs with the reconciliation
that found them.

Two limits on that rule, so it does not become a licence to balloon scope:

- **Record every in-process fix in the ledger and the writeup.** Fixed-not-filed must never mean
  invisible.
- **If a fix is not small, or is risky, or changes a public surface, stop and surface it** instead
  of absorbing it silently. "Fix it in process" is about not filing paperwork for trivia, not about
  making unreviewed judgement calls on real design.

## Non-negotiables

- **Zero hits is a result you must state**: ``0 hits for `<exact pattern>` ``.
- **Never audit from a title.** 6 of 6 findings false in one session, then 3 of 3 in another — all
  refuted by the ticket's own body.
- **A truncated listing is not an inventory.** A result exactly as long as your `head -N` limit is a
  truncation. `wc -l` first.
- **A comment citing a ticket is not independent evidence for that ticket.** One source, twice.
- **Prefer closing to implementing.**
