# Token-minimal max capability — workflow registry, intent map, compact profile

| | |
|---|---|
| **Status** | Design (not implemented) |
| **Date** | 2026-07-29 |
| **Goal** | Minimize client-agent tokens while preserving the full 151-capability engine (`REGISTERED_TOOL_COUNT` as of v1.13.1) |
| **Depends on** | triad facade (THE-219), `vault_context` / `session_bootstrap`, sleep-time plane, ADR-0006 |
| **Does not change** | Dispatch pipeline order, ACL/HITL/CAS, isnad boundary, dual DB membrane |

---

## 1. Problem

Agent token cost on MCP is dominated by:

1. **Catalog size** — mitigated by triad (`find` / `describe` / `call`).
2. **Multi-turn discovery** — find → describe → call is still **3 RTTs** and intermediate payloads.
3. **Hand-orchestration** — agents re-implement search → expand → pack as 5–20 tool calls even though `vault_context` already does this server-side.
4. **Session open/close** — skills and multi-tool dances instead of closed procedures.

The engine already *has* the expensive intelligence (GraphRAG stages, packing, contradictions, prewarm, plane jobs). What is missing is a **product surface that forces the cheap path**.

### Constraint (ADR-0006)

The default advertised surface remains **triad** until a **tool-selection eval** says otherwise. This design:

- Does **not** flip the default to a hand-curated 8–12 tool list.
- Adds **opt-in** `toolFacade.mode: "compact"` (and optional triad extensions that remain boundary-only).
- Ships the **eval harness** that ADR-0006 said was the reopen bar.

---

## 2. Design thesis

```text
Full capability stays registered and gated (unchanged).
Advertised surface collapses further for token-sensitive clients.
Agent procedures that are pure orchestration become typed Workflows.
Intent → capability resolution becomes one dispatch, not three.
Background plane keeps doing generative work off the interactive agent.
```

Three subsystems, one product:

| Piece | Name | Role |
|---|---|---|
| **A** | Intent map + `resolve_and_call` | Collapse find+describe+call → 1 RTT |
| **B** | Workflow registry | Closed multi-step procedures as single tools |
| **C** | Compact facade mode | Advertise only workflows + intent + minimal writes |

All three are **boundary-only**: every leaf capability still enters `registry.dispatch` (or is pure composition of dispatches). No ACL/HITL/idempotency bypass.

---

## 3. Architecture

```text
                    tools/list (compact)
        ┌──────────────────────────────────────┐
        │  resolve_and_call                      │  ← intent map (A)
        │  workflow_session_open                 │  ← workflows (B)
        │  workflow_research                     │
        │  workflow_session_close                │
        │  workflow_list  (optional meta)        │
        │  [optional] write_note / append_note   │  ← escape hatch writes
        └──────────────────┬───────────────────┘
                           │ each step
                    registry.dispatch(target, args, ctx)
                           │
        ┌──────────────────┼───────────────────┐
        ▼                  ▼                   ▼
  session_bootstrap   vault_context        end_session
  start_session       graph_search         write _next-session
  reflect (opt)       plane enqueue        prewarm enqueue
```

Unchanged under the floor:

- 151 tools still registered.
- `call_capability` / direct name calls still work when the client knows a name (security is scopes+ACL, not advertisement — same as today for `hidden` vs `disabled`).
- Facade never implements business logic that belongs in tools.

---

## 4. Piece A — Intent map + `resolve_and_call`

### 4.1 Why not only BM25 `find_capability`?

`find_capability` is already BM25 over name+description (good, free). Gaps:

- Still requires a second/third call.
- No **aliases** (“context”, “get context”, “what do I know about X”) → `vault_context`.
- No **arg lifting** (intent string contains the query that should become `vault_context.query`).

### 4.2 Public tool (boundary meta-tool, like triad)

```ts
// Advertised in triad (optional extension) and compact.
name: "resolve_and_call"
input: {
  intent: string,           // natural language: "research X", "read note foo.md"
  vault?: string,           // default: caller's bound vault / "main"
  args?: Record<string, unknown>,  // optional explicit overrides
  dry_run?: boolean,        // if true: return resolution only, do not dispatch
  min_score?: number,       // default 0 — reject ambiguous below threshold
}
output: {
  resolved: { name: string, score: number, source: "alias" | "bm25" | "workflow" },
  args_used: Record<string, unknown>,
  result?: unknown,         // omitted when dry_run
  alternatives?: { name: string, score: number }[],  // when ambiguous
}
```

### 4.3 Resolution algorithm (deterministic)

```text
1. Normalize intent (lowercase, trim, collapse whitespace).
2. Alias table (static, code-owned, versioned):
     exact phrase / regex → capability name + arg extractor
3. If no alias: BM25 over catalog (reuse findCapability()) with NAME_BONUS.
4. If top score < min_score OR (top2 within ε): return ambiguous (no dispatch).
5. Merge args:
     extractor(intent) ∪ input.args  (input.args wins on key clash)
6. If !dry_run: registry.dispatch(name, args_used, ctx)  // full pipeline
```

### 4.4 Initial alias table (v1)

| Pattern (intent) | Target | Arg extract |
|---|---|---|
| `^(context\|vault context\|get context\|what do (i\|we) know)\b` | `vault_context` | remainder → `query` |
| `^(research\|search vault\|look up)\b` | `workflow_research` or `vault_context` | remainder → `query` |
| `^(bootstrap\|session open\|start session)\b` | `workflow_session_open` | remainder → `message` |
| `^(session close\|end session\|wrap up)\b` | `workflow_session_close` | optional summary |
| `^(reflect\|summarize grounded)\b` | `reflect` | remainder → `query` |
| `^(read note\|open)\s+(\S+\.md)` | `read_note` | path group |
| `^(append\|log)\b` | `append_note` | needs args.path in `args` |
| `^(find tool\|which tool\|how do i)\b` | *(meta)* dry-run find only | — |

Alias table lives in `packages/server/src/mcp/intent-map.ts` (or `workflows/intent-map.ts`).  
**Not** operator config in v1 (operators can already pin tools via `toolVisibility`); keep resolution reproducible for the eval harness.

### 4.5 Triad interaction

**Option chosen:** extend triad to **four** tools when `toolFacade.intentRouter: true` (default **true** in compact, **false** in classic triad for zero behavior change):

| Mode | Advertised |
|---|---|
| `triad` + intentRouter false (today) | find, describe, call |
| `triad` + intentRouter true | find, describe, call, **resolve_and_call** |
| `compact` | workflows + resolve_and_call (+ optional write set) |

ADR-0006: classic triad default unchanged. Compact and intentRouter are explicit config.

### 4.6 Security

- `resolve_and_call` is **not** a privilege escalation: dispatch still checks scopes/ACL/HITL for the **target**.
- Ambiguous resolution must **not** guess a destructive tool: if top match is `destructive` or mutating, require either `args.confirm_intent: true` or score margin ≥ τ (configurable; default: never auto-pick destructive without exact alias).

---

## 5. Piece B — Workflow registry

### 5.1 What a workflow is

A **Workflow** is a registered MCP tool whose handler is a **fixed sequence of leaf tool dispatches and pure glue**, not an open-ended agent loop.

```ts
interface WorkflowDef {
  name: string;                 // e.g. workflow_research
  domain: ToolDomain;           // usually "knowledge"
  description: string;
  inputSchema: ZodType;
  outputSchema: ZodType;
  requiredScopes: string[];     // union of step scopes (or explicit superset)
  destructive?: boolean;
  /** For docgen / compact surface membership */
  tags: ["workflow", ...];
  run: (input, ctx, rt: WorkflowRuntime) => Promise<unknown>;
}

interface WorkflowRuntime {
  /** Always goes through registry.dispatch — same gates as a client call */
  call(name: string, args: unknown): Promise<ToolResult>;
  /** Vault registry, db, deps already on ctx */
}
```

Workflows register via the same `defineTool` → `registry.register` path so:

- `REGISTERED_TOOL_COUNT` increments.
- Facade domain map / docgen / audit treat them as normal tools.
- HITL fires if any step would (or workflow declares `destructive` and elicits once at the start — see 5.4).

### 5.2 Module layout

```text
packages/server/src/workflows/
  types.ts
  runtime.ts          # dispatch wrapper, step trace
  registry.ts         # buildWorkflowTools(deps) → ToolDefinition[]
  intent-map.ts       # aliases + resolve()
  session-open.ts
  research.ts
  session-close.ts
  index.ts
```

Wire in `cli.ts` after M7/M8 registration: `registerWorkflowTools(registry, deps)`.

### 5.3 v1 workflows

#### W1 — `workflow_session_open`

**Intent:** replace “start_session + bootstrap + maybe vault_context” agent dance.

```text
input:  { vault, message?, caller?, mode?: auto|lightweight|standard|deep,
          include_context?: boolean (default true), token_budget?: number }
steps:
  1. dispatch start_session { vault, caller: caller ?? ctx.caller ?? "agent" }
  2. dispatch session_bootstrap { vault, message: message ?? "", mode }
  3. if include_context:
       if _next-session.md readable:
         dispatch vault_context { vault, token_budget }  // bootstrap query
       else if message:
         dispatch vault_context { vault, query: message, token_budget }
output: {
  session_id, bootstrap: SessionBootstrapOutput,
  context?: VaultContextOutput,
  steps: [{ name, ok, ms }]
}
```

**Token win:** 1 call vs 3; agent context gets one structured blob.

#### W2 — `workflow_research`

**Intent:** one-call research pack (and optional gateway synthesis).

```text
input:  {
  vault, query,
  token_budget?: number (default 4000),
  synthesize?: boolean (default false),  // true → reflect after pack
  include_work?: boolean,
  k?: number
}
steps:
  1. dispatch vault_context { vault, query, token_budget, k, include_work }
  2. if synthesize:
       dispatch reflect { vault, query, ... }  // degrades if no gateway
output: {
  context: VaultContextOutput,
  answer?: ReflectOutput,   // only if synthesize
  steps: [...]
}
```

**Not in v1:** multi-facet fan-out fusion (measured harmful on golden set — see prompts.ts).  
If we add facets later: separate lists, no RRF merge (same as `decompose_and_research` prompt).

#### W3 — `workflow_session_close`

**Intent:** durable handoff for next session without agent creativity.

```text
input:  {
  vault, session_id,
  next_session_text?: string,   // written to memory/_next-session.md
  enqueue_prefetch?: boolean (default true),
  end_metadata?: object
}
steps:
  1. if next_session_text:
       dispatch write_note or governed write of memory/_next-session.md
         (CAS/snapshot path — use same persist helper as reflect.persist)
  2. dispatch end_session { vault, session_id, end_metadata }
  3. if enqueue_prefetch: schedule prewarm job (existing prefetch CLI path)
output: { ended: EndSessionOutput, next_session_path?, prefetch_enqueued: boolean }
```

### 5.4 HITL and multi-step mutation

- **Read-only workflows** (research with `synthesize: false`, session_open without writes beyond start_session): normal scope checks per step.
- **session_close** writing `_next-session.md`: requires `write:notes` (or workspace policy); use existing write tools so CAS/snapshots apply.
- **Do not** invent a single “workflow HITL skips step HITL” — if a step is destructive, that step’s elicit fires. Optional later: workflow-level elicit once with args_hash covering the whole plan (out of scope for v1).

### 5.5 Observability

Each workflow emits one outer tool_invocation audit row (the workflow name) plus **child** rows via normal dispatch (already happens if steps use `registry.dispatch`).  
Add `DispatchEpisode.parent_tool?: string` only if audit correlation needs it; otherwise step names in the workflow output + existing per-call audit are enough for v1.

### 5.6 Failure policy

| Step fails | Behavior |
|---|---|
| Non-retryable (ACL, validation) | Abort workflow; return structured partial `steps` + error |
| Retryable (throttle) | Surface retryable; do not auto-retry loop inside workflow (avoid hidden spin) |
| Optional step (synthesize, prefetch) | Record skip/degrade; overall `ok: true` with `degraded: [...]` |

---

## 6. Piece C — Compact facade mode

### 6.1 Config

```ts
// packages/shared — extend ToolFacadeConfigSchema
toolFacade: {
  mode: "triad" | "domain" | "flat" | "compact",  // compact NEW
  intentRouter: boolean,  // default false; true when mode=compact
  compact?: {
    /** Extra leaf tools to advertise alongside workflows (writes). */
    writeTools: string[],  // default ["write_note","append_note","patch_note"]
    /** Advertise resolve_and_call (default true). */
    intentTool: boolean,
    /** Advertise workflow_list meta (default false). */
    listWorkflows: boolean,
  }
}
```

### 6.2 `tools/list` when `mode === "compact"`

Return a **fixed small list** (order stable for cache hints):

1. `resolve_and_call` (if intentTool)
2. `workflow_session_open`
3. `workflow_research`
4. `workflow_session_close`
5. Each name in `compact.writeTools` that is visible to the caller (scopes/ACL)
6. Optionally `find_capability` / `call_capability` as escape hatches — **default off** in compact (forces the cheap path). Operators who want escape hatch set `compact.escapeHatch: true` → adds find/describe/call.

**Callable by name:** still true for all registered tools (same as triad).  
**Security disable:** still `toolVisibility.disabled*`.

### 6.3 Relationship to `toolVisibility.allowed`

`allowed` remains the low-level allowlist. Compact mode is a **preset advertisement**, not a second security system.

Recommended operator config for multi-agent token-min:

```json
{
  "toolFacade": { "mode": "compact", "intentRouter": true },
  "auth": { "mode": "jwt", "...": "..." },
  "acl": { "...": "..." }
}
```

### 6.4 Default product recommendation

| Audience | mode |
|---|---|
| Existing users / ADR-0006 | `triad` (unchanged default) |
| Token-sensitive multi-agent | `compact` |
| Power users / debugging | `flat` or triad + escape |

---

## 7. Client agent contract (minimal system prompt)

Replace multi-page SKILLS for compact clients with:

```text
You have a governed Obsidian memory engine.
1. Open: workflow_session_open({ message })
2. Question: workflow_research({ query, token_budget }) or resolve_and_call({ intent })
3. Write only via write_note/append_note/patch_note when asked to change notes.
4. Close: workflow_session_close({ session_id, next_session_text })
Do not invent tool names. Do not hand-chain search tools.
```

Ship as:

- `llms.txt` section
- `examples/compact-agent-system.md`
- Built-in prompt `use_compact_surface` (prompts/get) that returns the above

---

## 8. Tool-selection eval (ADR-0006 reopen instrument)

### 8.1 Location

`packages/server/eval/tool-selection/`

### 8.2 Dataset

JSONL of cases (start public/synthetic, n≥50):

```json
{"id":"ts01","utterance":"what do we know about graph densification?","gold":["vault_context","workflow_research"],"forbidden":["write_note"]}
{"id":"ts02","utterance":"append a bullet to daily note","gold":["append_note"],"args_required":["path"]}
```

### 8.3 Metrics

| Metric | Definition |
|---|---|
| **Top-1 accuracy** | resolve_and_call dry_run name ∈ gold |
| **Alias hit rate** | source === "alias" |
| **Ambiguity rate** | refused correctly when gold says ambiguous |
| **Destructive false positive** | mutating tool chosen when gold is read-only |
| **RTT proxy** | steps to success: compact path should be 1 |

### 8.4 Compare surfaces

Run the same utterances through:

- Simulated agent with triad (find→call heuristic)
- resolve_and_call
- compact workflow forced map

Ship rule for enabling `intentRouter: true` **by default on triad**: top-1 ≥ triad-BM25 baseline and destructive FP = 0 on the set.

---

## 9. Implementation plan (PR slices)

| PR | Scope | Risk | Gate |
|---|---|---|---|
| **PR1** | `workflows/types.ts` + `runtime.ts` + `workflow_research` only (compose vault_context ± reflect) | Low | unit tests with mock registry; tool count + domain coverage |
| **PR2** | `workflow_session_open` / `close` | Med (writes `_next-session`) | integration tests; snapshot/CAS paths |
| **PR3** | `intent-map.ts` + `resolve_and_call` meta-tool + facade wiring | Med | dry_run tests; destructive safety tests |
| **PR4** | `toolFacade.mode: "compact"` + config schema + examples | Low | tools/list snapshot test |
| **PR5** | Tool-selection eval harness + initial JSONL | Low | CI job optional/manual first |
| **PR6** | `llms.txt`, compact system prompt, SKILLS.md section, docgen facts | Low | docgen gates |

**Do not** combine PR3 defaults with PR4 default flip. Default `mode` stays `triad`.

### Code touch map (expected)

| File / area | Change |
|---|---|
| `packages/shared/src/config.schema.ts` | `compact` mode + intentRouter + compact block |
| `packages/server/src/mcp/facade.ts` | compactTools(); optional resolve_and_call in triadTools |
| `packages/server/src/mcp/server.ts` | tools/list + tools/call routing for resolve_and_call / workflows |
| `packages/server/src/workflows/*` | new |
| `packages/server/src/cli.ts` | register workflows |
| `packages/server/test/registered-tool-count.ts` | +N workflows + maybe resolve tool |
| `packages/server/test/tool-facade-*.ts` | compact surface |
| docgen / README / SKILLS | compact path |

`resolve_and_call` can be either:

- **(Preferred)** a true registered tool with domain `admin` or `knowledge` and tags `["workflow","facade"]`, so audit and counts stay uniform, **or**
- facade-only meta like find/describe (not in registry list) — **avoid** if we want one code path; prefer registered tool so compact `allowed` lists work.

**Decision:** register `resolve_and_call` as a real tool; its handler uses the intent map + `registry.dispatch` for the target (re-entrant dispatch is fine if we prevent recursion: target must not be `resolve_and_call`).

---

## 10. Token budget — expected outcome

| Client path | Tools advertised | Typical RTTs / question | Context shape |
|---|---|---|---|
| Flat 151 | ~151 schemas | 5–20 | huge |
| Triad today | 3 | 3+ (discover) + N | still multi-search risk |
| **Compact + research workflow** | ~6–8 | **1** | one packed `vault_context` (~token_budget) |
| Compact + session | same | 1 open + 1 research + 1 close | sessions durable |

Capability remains 151 underneath; **advertised decision space** drops below cyanheads/enquire while depth stays higher.

---

## 11. Non-goals (v1)

- In-server free-form ReAct loop over 151 tools  
- Flipping default facade away from triad  
- Multi-facet RRF research (measured loss)  
- Replacing gateway `reflect` with a second agent  
- Workflows that bypass HITL  
- Encoding vault house-style paths as hard-coded constants (bootstrap config remains the table)

---

## 12. Open questions (resolve at implement time)

1. **Should `workflow_*` names be the only research entry, or also alias `vault_context` directly?**  
   Recommendation: alias both; prefer workflow in compact docs so synthesize flag is discoverable.

2. **Recursion guard:** max dispatch depth = 1 from resolve_and_call, and workflows may only call **non-workflow** leaves (or a fixed allowlist of leaves). Prevents workflow → workflow cycles.

3. **Tool count / docgen:** each workflow is a real tool → +3–5 on REGISTERED_TOOL_COUNT; update facts once in PR1–2.

4. **Scopes on workflows:** declare the **union** of step scopes so listVisible doesn’t advertise an undispatchable workflow; handler still dispatches steps with the same ctx.

---

## 13. Success criteria

| Criterion | Measure |
|---|---|
| Token path | Compact client answers a vault question in **1** tool call |
| Safety | 0 destructive auto-resolves without alias/confirm in eval set |
| Compatibility | Default install still triad; existing clients unchanged |
| Depth | All 151 capabilities still reachable by name / resolve / call_capability (if escape on) |
| ADR-0006 | Tool-selection eval exists and is runnable in CI |

---

## 14. Summary

Implement a **workflow registry** and **intent map** on top of the existing dispatch and composites (`vault_context`, `session_bootstrap`, sessions, `reflect`), expose them through an opt-in **`compact` facade mode**, and measure tool selection so any future default change is evidence-based.

This is the shortest path from “151 capabilities with a 3-tool facade” to “maximum capability with near-minimum agent tokens” without rewriting the engine or violating the security spine.
