# Issue tracker: Linear

Issues for this repo live in **Linear**, on the **The 13th Letter** team (identifier prefix `THE-`).
Pull requests live on **GitHub** (`The-40-Thieves/obsidian-tc`) and are *not* the issue tracker —
see [Pull requests](#pull-requests) below for how the two relate.

All Linear operations go through the **Linear MCP server**. Tool names below are given unprefixed
(`list_issues`, `save_issue`, …); your harness may namespace them (e.g.
`mcp__claude_ai_Linear__list_issues`). Match on the trailing operation name.

If the Linear MCP server is unavailable, **stop and say so** — do not fall back to writing
markdown files under `.scratch/`. A ticket that isn't in Linear is invisible to the human.

## Conventions

- **Create an issue**: `save_issue` with `team: "The 13th Letter"` and a `title`. Omit `id` when
  creating. `description` is Markdown — pass literal newlines, never `\n` escape sequences.
- **Read an issue**: `get_issue` with the identifier (e.g. `THE-462`). Use `list_comments` for the
  discussion; `get_issue` alone does not include it.
- **List issues**: `list_issues` with `team`, plus `state`, `label`, `assignee`, `parentId`, or
  `query` as filters. `state` accepts a state **type** (`backlog`, `unstarted`, `started`,
  `completed`, `canceled`) as well as a name — prefer the type, it survives workflow renames.
- **Comment**: `save_comment` with `issueId`.
- **Apply labels**: `save_issue` with `labels: [...]`. **This replaces the entire label set** —
  read the current labels with `get_issue` first and pass them back, or you will silently drop
  labels someone else applied.
- **Close**: `save_issue` with `state: "completed"` (or `"canceled"` for won't-do).
- **Assign**: `save_issue` with `assignee: "me"`.

Issues are referenced by identifier (`THE-462`), not a bare number. Use the identifier everywhere
a skill says "the ticket number".

## Pull requests

PRs are on GitHub, via the `gh` CLI, and are a **delivery** surface — not a request surface.

**PRs as a request surface: no.** _(`/triage` reads this flag. Flip to `yes` only if this repo
starts taking external PRs as feature requests.)_

Because the repo is public but the backlog is private, the two surfaces are deliberately split:

- A **Linear issue** is the unit of planned work. Every branch traces back to one.
- A **GitHub PR** is how that work lands. Reference the Linear identifier in the PR title or body
  so the trail survives.
- Commits require DCO sign-off (`git commit -s`) — the `dco-check` job fails without it.

### Precedence when sources disagree

Established convention for this repo, strongest first:

1. **The merged commit** — what's actually on `main`
2. **The code** — what the working tree says
3. **Linear** — the ticket's state
4. **The vault** — notes and planning docs

A merged PR does not by itself mean a ticket is done; verify against the code before closing.

## When a skill says "publish to the issue tracker"

Create a Linear issue on the **The 13th Letter** team.

## When a skill says "fetch the relevant ticket"

`get_issue` with the `THE-` identifier, then `list_comments` for the discussion.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue; its **tickets** are child issues.

- **Map**: an issue labelled `wayfinder:map`, holding the Destination / Notes / Decisions-so-far /
  Not-yet-specified / Out-of-scope body. Create with `save_issue`, `labels: ["wayfinder:map"]`.
- **Child ticket**: `save_issue` with `parentId: "<map identifier>"` — Linear's native
  parent/sub-issue relation, which renders the map's children in the UI without any body
  convention. Label each with its type: `wayfinder:research`, `wayfinder:prototype`,
  `wayfinder:grilling`, or `wayfinder:task`.
- **Blocking**: Linear's **native issue relations** — `save_issue` with
  `blockedBy: ["THE-123"]` on the blocked ticket (or `blocks: [...]` from the other side). Both are
  **append-only**; use `removeBlockedBy` / `removeBlocks` to retract an edge. This is the canonical
  representation: Linear renders it as a blocking badge on the board, so the frontier is visible to
  the human without opening the map.
- **Frontier query**: `list_issues` with `parentId: "<map>"`, `state: "unstarted"` (and `"backlog"`),
  `assignee: null` — the map's open, unclaimed children. `list_issues` does not return relation
  state, so `get_issue` each candidate and drop any whose `blockedBy` relations are not all
  completed. First in map order wins.
- **Claim**: `save_issue` with `assignee: "me"` **and** `state: "started"` — the session's first
  write, before any work, so a concurrent session skips the ticket.
- **Resolve**: `save_comment` with the answer, then `save_issue` with `state: "completed"`, then
  append a one-line gist + link to the map's **Decisions so far**.

### Labels this repo still needs

The `wayfinder:*` labels do **not** exist on the The 13th Letter team yet. Create them before the
first `/wayfinder` run: `wayfinder:map`, `wayfinder:research`, `wayfinder:prototype`,
`wayfinder:grilling`, `wayfinder:task`. See also `triage-labels.md` for the triage vocabulary,
which is likewise not yet created.
