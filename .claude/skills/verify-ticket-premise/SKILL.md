---
name: verify-ticket-premise
description: Use before implementing any Linear ticket in this repo — checks the ticket's cited file:line references, counts, and central claim against HEAD and reports HOLDS / PARTLY STALE / FALSE before any code is written.
---

# verify-ticket-premise

**Run this before writing code for a ticket. Every time.**

Tickets in this repo go stale fast and stale confidently. A sample from a single session:

| ticket | claimed | actual |
|---|---|---|
| THE-417 | "0 of 141 tools populate `outputSchema`" | **all 150 did**; the fail-closed phase had also shipped |
| THE-464 | "~40% of vector bytes duplicated" | **0.06%** on the real vault — the 40% was a synthetic fixture |
| THE-510 | "blocked on THE-503" | THE-503 had shipped **5 days earlier** |
| THE-424 | runbook step "flip `activationRerank`" | the flag reaches no ranking code — a no-op |
| THE-514 | "path ACL is written twice" | identical arg lists; one shared helper, two callers |

Acting on any of those as written would have wasted between an afternoon and a week. Two of them
would have *introduced* defects. The check below costs minutes.

## Procedure

### 1. Read the ticket in full, including comments
`mcp__claude_ai_Linear__get_issue`. **The newest comment often supersedes the body** — several
tickets here carry a `RE-SCOPED` or `CORRECTED` header whose body below it is preserved but wrong.

### 2. Resolve every `file:line` it cites
For each, distinguish three outcomes — they mean different things:

- **EXACT** — the line still holds what the ticket says.
- **MOVED** — the symbol exists, at a different line. Harmless; note the new location.
- **GONE** — no longer exists. The ticket's reasoning may rest on something deleted.

Read the line. Do not infer from the file existing.

### 3. Re-derive every number
Tickets quote tool counts, test counts, line counts, coverage, corpus sizes, versions. Check each:

```bash
rg -c 'REGISTERED_TOOL_COUNT' packages/server/test/registered-tool-count.ts   # tool surface
wc -l <cited file>                                                            # line counts
npm view <pkg> version                                                        # dependency currency
```

**A number being CI-gated does not make it true of production.** `embed.dup_ratio 0.400` is a hard
gate — and it measures a synthetic 5:1 fixture, not any real vault. Ask what the metric's *fixture*
is before quoting it as evidence.

### 4. Test the central claim
The one sentence the ticket rests on. Search by **capability, not by the ticket's chosen
identifier** — work frequently ships under a different name than the ticket uses. THE-492 asked for
a `note_quality` rollup that had already shipped under exactly that table name; THE-417's
fail-closed phase shipped as `strictOutputSchema`.

### 5. Report before coding

```
PREMISE HOLDS         — proceed
PREMISE PARTLY STALE  — proceed with the corrected scope, and fix the body
PREMISE FALSE         — do not implement; close or rewrite the ticket
```

## Rules

- **Zero hits is a result you must state.** Write ``0 hits for `<exact pattern>` ``. An empty grep
  and a real absence are indistinguishable unless you say which you found.
- **Do not build an inventory from one grep.** Check the code that *consumes* a symbol, not only its
  definition.
- **"Code exists" ≠ "code is reachable."** Several subsystems here were built, tested, and wired to
  nothing. Find a production call site.
- **Prefer closing to implementing.** Twice in one session the correct output was a closed ticket
  and no code.

## Applies to more than tickets

The same check applies to any confident claim you did not verify this session — a code comment
vouching for an invariant, a doc stating a count, a metric quoted as evidence. Reassurance written
next to code ages exactly as badly as documentation and gets read with more trust.
