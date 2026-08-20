# THE-707 — does a public "experiential memory" benchmark fit obsidian-tc? (STEP 0 finding)

**Verdict: genuinely poor fit. No adapter was built.** This file records the research so the
question isn't re-opened from scratch next time it comes up.

## What obsidian-tc's experiential tier actually is

Read directly from the code, not from the tier's name:

- **`agent_episodes`** (`packages/server/src/experiential/episodes.ts`) — one row per **MCP tool
  dispatch outcome** against a vault (`tool`, `args_hash`, `status`, `task_result`, an
  LLM-generated `summary` of what the call did). Rows are born `eligibility='pending'`; a
  deterministic sleep-time pass (`reflect.ts`) promotes/holds them. There is no code path that
  ingests arbitrary prose into this table — every writer is a real dispatch outcome.
- **`preference_profile`** (`packages/server/src/experiential/reflect.ts`) — despite the migration
  header literally calling it *"the LongMemEval preference-class mechanism"* (`20260712_001_preference_profile.sql`),
  the implementation is a single closed-vocabulary counter: `PREFERENCE_KEYS = new
  Set(["preferred.search_mode"])` (reflect.ts:425). `extractPreferences` derives deltas ONLY from
  `agent_episodes`/`chunk_retrievals` telemetry — which search tool got cited — never from
  free-text statements. `filterRegisteredDeltas` silently drops any other key. It cannot represent
  "the user's favorite cuisine is Thai"; there is no code path that would let it.
- **`work_search`** (`packages/server/src/tools/m8/work-search-tool.ts`) — lexical + optional
  semantic (RRF-fused) search **over `agent_episodes.summary`**, i.e. over the tool-call log above.

So "experiential tier" here means *episodic memory of the agent's own tool-call history against a
vault*, plus one narrow revealed-preference counter. It is not a chat-turn store and cannot be
made into one without a product change.

## What the three candidate benchmarks actually contain

Checked against the HF dataset cards / repo schema / paper (`ctx7`/WebSearch/WebFetch, 2026-08-20):

- **LongMemEval** (`xiaowu0162/longmemeval`, 500 Qs) — `haystack_sessions`: lists of **user/assistant
  chat turns** (`{"role", "content"}`), ~40 sessions / 115K tokens per item. Question types:
  single-session-user/assistant/preference, multi-session, temporal-reasoning, knowledge-update.
  One item = a chat history + a probing question + a gold answer + a type. **`single-session-preference`
  tests recall of an arbitrary NL-stated preference** (e.g. a stated food/travel preference) —
  exactly the shape `preference_profile` cannot hold (closed vocabulary, one key).
- **LongMemEval-V2** (`xiaowu0162/longmemeval-v2`, 451 Qs / 1,870 trajectories) — `trajectories.jsonl`:
  **multimodal WebArena/ServiceNow-style web-agent action trajectories** (text observations +
  `screenshots/<traj_id>/<step>.png`), up to 500 trajectories / 115M tokens per item. Question
  types (five "memory abilities"): static state recall, dynamic state tracking, workflow
  knowledge, environment gotchas, premise awareness — all about **GUI web-browsing state**
  (OneStopShop/CMS/Reddit/ServiceNow), not tool calls against a note vault. Requires a vision-capable
  reader. There is no honest mapping from "click checkout on a shopping site" trajectories onto
  `agent_episodes` rows, which are Obsidian-vault tool dispatches (`search_notes`, `read_note`,
  `create_note`, …).
- **BEAM** (`Mohammadta/BEAM` / `BEAM-10M`) — same shape as LongMemEval: 100 long **multi-turn
  chat conversations** (128K–10M tokens), 2,000 probing questions across ten memory abilities
  (information extraction, multi-hop, knowledge update, temporal reasoning, preference following,
  contradiction resolution, etc.). Chat-conversation memory, not episodic tool-call memory.

## Why forcing an adapter would be dishonest, not just imperfect

The only way to get any of the three benchmarks' "history" into `agent_episodes` is to **write
synthetic rows directly** — `summary = <chat turn text>`, a fabricated `tool` label, forced
`eligibility='eligible'` — bypassing every real writer in the system (real dispatch capture, the
poison scanner, the sleep-time promotion pass). What that would measure is *"can `work_search`'s
lexical+semantic RRF fusion retrieve a paraphrase of a query from a pool of injected text
snippets"* — i.e. the general retrieval plane's text-search mechanics, which is **already
benchmarked** by the private multi-hop golden set (`eval/run.ts`, `eval/gen-multi-hop-slice.ts`,
n=250, documented in `eval/README.md`). Dressed up with a LongMemEval label and a QA-accuracy
number, that result would read as "the experiential tier scores X% on a published benchmark" while
actually exercising none of the tier's real mechanics (capture, poison/eligibility gating,
preference extraction, episode chaining) — the exact "misleading aggregate" this ticket says not
to produce. No question type in any of the three benchmarks survives without this forcing:
non-preference types need free-text episodic recall (no real producer for that), and the one
preference type needs a preference store that isn't closed-vocabulary (also no real producer).

## Recommendation

- **Do not adopt LongMemEval / LongMemEval-V2 / BEAM for the experiential tier as-is.** They measure
  conversational or GUI-browsing memory; obsidian-tc's experiential tier measures episodic memory
  of its own tool calls. A benchmark that doesn't measure the system under test is worse than none.
- **The general retrieval plane is not unbenchmarked** — `eval/run.ts` already scores it
  (recall@10/nDCG@10/MRR@10/bridge-recall, n=250, statistically gated). What's actually missing is
  an *episodic*-memory-specific benchmark.
- **The honest path to "the one axis competitors publish on"** is a home-grown benchmark built the
  same way the multi-hop golden set was: mine real (or realistically dogfooded) `agent_episodes`
  sessions, hand-curate probing questions whose gold answer is answerable from real episode
  summaries/`task_result`/`preferred.search_mode`, and score via `work_search` + an LLM judge
  (reusing the `citation.ts` strict-JSON judge pattern). That is a new-corpus-construction effort,
  not an adapter, and is out of scope for this ticket's budget — filed as a follow-up rather than
  attempted here to avoid producing a rushed, under-curated golden set.
