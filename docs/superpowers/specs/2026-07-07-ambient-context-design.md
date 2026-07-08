# Ambient Context Capture — Design Spec

**Status:** Draft — approved via brainstorming session, pending implementation plan
**Date:** 2026-07-07
**Owner:** Suavecito585

## 1. Summary

obsidian-tc governs access to *vault* content. This feature adds a second, deliberately separate capability: **ambient context** — a continuous, low-trust record of what's currently on the user's screen across *any* application, captured locally and exposed to agents through the same governed dispatch pipeline as everything else. The goal is to let an agent answer "what am I working on right now?" and "what was I working on with X last week?" without the user re-explaining context every time.

This is the single most privacy-sensitive capability obsidian-tc will ever ship. Every design decision below is made in that light: fail closed on anything touching redaction, keep the OS permission grant on the smallest possible surface, and never let this capability's data model touch the authoritative vault/memory stores directly.

## 2. Goals and non-goals

**Goals (v1, agreed in brainstorming):**
- Both a live "what's on screen right now" read and a persistent, searchable history, from the first release — not staged as live-only-then-history-later.
- Cross-platform from day one: macOS, Windows, and Linux.
- Text/accessibility-tree capture only. No audio, no microphone, no video, no meeting-notetaker. (That is a distinct, larger feature and explicitly out of scope here.)
- Default-allow capture with a pre-seeded denylist for known-sensitive app categories, **plus** content-level redaction that runs regardless of which app is in focus, so a sensitive app that isn't yet on the denylist doesn't leak credentials/PII by omission.
- Long default retention (180 days) because the whole point is genuine recall, not a rolling 24-hour buffer.

**Non-goals (v1):**
- Audio/meeting transcription (Littlebird's second product surface — a separate future spec if ever pursued).
- Semantic/vector search over ambient history (FTS5 only for v1 — see §7).
- Live, on-demand "force refresh" round-trip to the sensor for `get_current_context` (reads the latest already-captured row instead — see §6).
- Cloud/remote deployment support. This capability is inherently local-desktop-only (§3).

## 3. Scope constraint: local-desktop only

Ambient capture requires OS accessibility permission tied to a live, local GUI session. This is incompatible with obsidian-tc's Docker and HTTP-remote deployment modes by construction — there is no desktop session for a container or a remote host to read. This capability is only ever active in **STDIO-local** or **HTTP-local** deployments, on the same machine as the user. This is the same constraint the existing Obsidian companion plugin already has, and the architecture below deliberately reuses that precedent (§4).

## 4. Architecture

```
┌─────────────────────────────┐          ┌────────────────────────────────────┐
│   SENSOR HELPER (per-OS)     │          │            obsidian-tc server        │
│  packages/sensor             │  push    │                                       │
│  ┌────────────────────────┐  │ ───────► │  POST /ambient/v1/capture             │
│  │ macOS: AXUIElement      │  │ (bearer, │    → redact (pass 2) → dedupe        │
│  │ Windows: UI Automation  │  │  local   │    → ambient.db                      │
│  │ Linux: AT-SPI (dbus)    │  │  secret) │                                       │
│  └────────────────────────┘  │          │  GET /ambient/v1/probe  ◄──────────── │
│  - poll every Ns              │ ◄─────── │    (health/capability check,          │
│  - app-identity check FIRST   │  probe   │     same taxonomy as the Obsidian     │
│  - redact (pass 1)            │          │     companion: missing/unreachable)   │
│  - hash + dedupe locally      │          │                                       │
└─────────────────────────────┘          │  MCP tools ("ambient" domain):        │
                                          │    get_current_context   (read:ambient)│
                                          │    search_ambient_context(read:ambient)│
                                          │  → same auth→scope→HITL→audit pipeline │
                                          └────────────────────────────────────┘
```

### 4.1 New workspace package: `packages/sensor`

A Rust binary per platform, reusing the cross-compilation investment already in place for the native module (cargo-zigbuild for musl targets, etc.). It is a sibling to `packages/plugin` (the Obsidian companion) in spirit — a helper that lives outside the main server process because it needs a capability the server itself shouldn't hold — but it is OS-wide rather than vault-scoped, so it isn't an Obsidian plugin at all.

**The sensor is the only thing that ever requests Accessibility / UI Automation / AT-SPI permission.** The main obsidian-tc server binary never needs it. This keeps the most sensitive OS grant on the smallest, most auditable piece of code in the system.

Installed via a new CLI subcommand, `obsidian-tc sensor install`, mirroring `obsidian-tc plugin install`. Installation also registers the appropriate per-OS autostart:
- macOS: a user LaunchAgent
- Windows: a scheduled task (user-level, not a system service, to avoid requiring admin)
- Linux: a systemd user unit

**Push, not pull.** Unlike the Obsidian companion bridge (server calls out to the plugin), the sensor generates a continuous event stream, so it pushes to the server:
- `POST /ambient/v1/capture` — sensor → server, authenticated with a dedicated local secret (`ambient.sensorApiKey`, generated at `sensor install` time). This secret is **not** part of the MCP JWT/scope surface. No MCP-authenticated caller, however privileged, can hit this endpoint or inject a fake capture through it.
- `GET /ambient/v1/probe` — server → sensor, health/capability check, reusing the `plugin_missing` / `plugin_unreachable` / `plugin_incompatible` error taxonomy already established for the Obsidian companion probe.

### 4.2 Native layer stays thin (testability principle)

The platform-specific Rust code exposes exactly one primitive per platform: "give me the focused window's app identity, title, and visible text." Every other piece of logic — app-policy evaluation, content-hash dedup, redaction, retention math, tool handlers — lives in shared, platform-agnostic code with an injectable fake window/text source (mirroring the existing `bridge/fake.ts` / `embeddings/fake.ts` pattern). This is what makes the feature testable at all: CI runners have no live GUI session, especially on Linux, so real accessibility APIs cannot run in CI regardless of platform.

## 5. Data model

New physically separate store: **`ambient.db`**, following the exact philosophy already established by `experiential.db` (the "low-trust membrane") — no foreign keys into `cache.db`, so ambient data can never contaminate the authoritative vault/memory graph, and a reset is a file truncate.

```sql
CREATE TABLE ambient_captures (
  id            TEXT PRIMARY KEY,      -- "amb_<random>"
  app_name      TEXT NOT NULL,
  app_bundle_id TEXT NOT NULL,         -- macOS bundle id / Windows AUMID / Linux desktop-file id
  window_title  TEXT,
  content       TEXT NOT NULL,         -- already redacted (both passes) by the time this is written
  content_hash  TEXT NOT NULL,         -- dedupe key
  platform      TEXT NOT NULL,
  captured_at   INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL       -- retention sweep target
);

CREATE VIRTUAL TABLE ambient_captures_fts USING fts5(
  content, window_title, app_name,
  content='ambient_captures', content_rowid='rowid'
);

CREATE TABLE ambient_app_policy (
  app_bundle_id TEXT PRIMARY KEY,
  policy        TEXT NOT NULL,         -- 'allow' | 'deny'
  source        TEXT NOT NULL,         -- 'default_seed' | 'user'
  updated_at    INTEGER NOT NULL
);
```

**No `vault_id` column anywhere in this store.** Ambient context answers "what's on this machine," not "what's in this vault" — it has no vault boundary, closer in shape to the `plur` integration (explicitly documented as "GLOBAL, not per-vault"). This is a deliberate first: every other tool domain in obsidian-tc takes a `vault: VaultId` argument; the ambient tools will not.

## 6. Data flow

**Capture:**
1. Sensor polls the focused window at a configurable interval (default 2s).
2. **App identity is resolved and checked against policy *before* any content is read.** A denied app's content is never extracted into the sensor's memory at all — this is a stronger property than "capture then filter."
3. If allowed: extract text via the platform accessibility primitive.
4. Compute `content_hash` (SHA-256 of the extracted content text). The sensor keeps a small in-memory LRU mapping `(app_bundle_id, window_title) → last content_hash sent`; if the new hash matches the cached one for that window, the poll is dropped with no DB write and no network call — this is what keeps an idle screen from generating a row every 2 seconds. (`content_hash` itself is a hash of content only; the window identity is the LRU key, not part of the hash input.)
5. Redaction pass 1 runs on genuinely-changed content, extending the existing `search/secrets.ts` pattern-matching with PII patterns (SSN, card numbers, routing/account numbers) alongside its existing credential patterns.
6. `POST /ambient/v1/capture` to the server.
7. Server: redaction pass 2 (defense in depth against a stale or compromised sensor; **fail closed** — if this pass errors for any reason, the capture is dropped and never stored) → server-side app-policy re-check (defense in depth) → compute `expires_at` from configured retention → insert into `ambient_captures` + FTS (index-on-write) → emit through the *existing* observability path unchanged: OTel span, Prometheus counter, MORGIANA event, `event_log` row. Ambient captures show up in the same audit trail as every other tool call, with no new observability system required.
8. The existing hourly maintenance sweep gains one more job: purge `expires_at < now`, same pattern as idempotency/elicit-token reaping.

**Retrieval:**
- `get_current_context` (scope `read:ambient`): reads the most recent row(s) from `ambient_captures`. No live round-trip to the sensor in v1 — at a 2s poll interval, "latest stored row" is already near-real-time, and it keeps this tool's behavior consistent with `search_ambient_context` (both just query the store). A true on-demand force-refresh is a candidate v1.1 addition if the cached-latest approach feels stale in practice.
- `search_ambient_context` (scope `read:ambient`): FTS5 query with time-range and app filters, paginated (reuses the existing `Pagination` schema helper).

**Policy changes purge retroactively.** Adding an app to the denylist (via an `admin:ambient`-scoped operation) also purges that app's already-stored historical rows, not just future captures — a user tightening policy gets what they'd expect rather than a silent gap.

## 7. Retention

Default: **180 days**, configurable via the existing `maintenance` config block (same block that already governs the sweep interval). Documented presets: 30 / 60 / 90 / 120 / 180 / 360 days — but config accepts any positive integer; the presets are suggested values, not an enum constraint.

## 8. Indexing strategy: FTS5 only (v1)

No embeddings, no vector search, in v1. Two reasons, both direct consequences of earlier decisions in this spec:
1. **Volume.** A 2-second poll interval with 180-day retention accumulates a lot of rows even after content-hash dedup. Routing all of that through an embedding provider on every write is a real, ongoing cost that hasn't been explicitly signed up for.
2. **Privacy.** This is the most sensitive data category in the whole system. Routing it through whatever embedding provider happens to be configured — including cloud providers — by default is a meaningfully different privacy posture than the FTS5-only, fully-local alternative.

Semantic search over ambient history is a reasonable v2 extension, following the same "gateway rerank degrades gracefully when absent" pattern already used elsewhere in the system — opt-in, not default.

## 9. Security model

- **Scopes:** `read:ambient` (the two MCP tools), `admin:ambient` (policy edits, purge). Both flow through the existing auth → scope → HITL → audit dispatch pipeline. There is no folder ACL layer for this domain (no folders) — the per-app allow/deny list is the ACL-equivalent, enforced **at capture time in the sensor**, not at read time (if it was never captured, there is nothing to filter later).
- **HITL:** not required for the read tools (plain reads, consistent with existing floor rules). Purge/policy operations are `admin:ambient`-scoped, not HITL-gated — same precedent as `reset_vault_cache`.
- **Fail-closed redaction is the load-bearing security property of this entire feature.** Any redaction-pipeline error drops the capture. This must never degrade to "store it anyway."
- **Kill switch:** `obsidian-tc sensor pause` (and `ambient.enabled: false` in config) stops capture immediately — needs to be at least as fast to reach as the vault's `readOnly` kill switch, since the failure mode here (screen-sharing, a sensitive document open) is more time-sensitive than a vault write mistake.
- **Rate limiting:** the ingest endpoint gets its own throttle tier, keyed on the sensor's caller hash (no vault to key against) — guards against a buggy sensor flooding writes even though dedup should make this rare in practice.
- **Response governor:** `search_ambient_context` results pass through the same byte-governor ceiling as every other tool response.
- **Sensor health is an observability concern, not a per-call error.** Installed/permission-granted/last-successful-capture status surfaces via `server_health` alongside the existing `native_loaded` / `vec_enabled` / `fts_enabled` flags. Read tools just query the store regardless of current sensor status — older data stays validly searchable even while the sensor is down.

## 10. Vault promotion path

When a user or agent wants to permanently save a specific ambient snapshot, it is enqueued into the **existing** `capture_queue` with `source: "ambient"`, and goes through the existing `commit_capture` flow. No new promotion mechanism — this reuses the inbox pattern that already exists for exactly this "staged, not-yet-authoritative content" purpose.

## 11. Testing strategy

- **Injectable fake sensor source**, mirroring `bridge/fake.ts` / `embeddings/fake.ts`, so redaction/dedupe/policy logic gets full unit coverage without a live OS session (CI has none). The native binaries themselves only need a thin compiles-and-links smoke test per platform.
- **Redaction test suite** (highest priority, given §9): fixture-based tests with known SSN / Luhn-valid test card numbers / banking-pattern content that must never survive either redaction pass, plus an explicit fail-closed test (forced redaction-pipeline error → capture dropped, not stored).
- **Ingest endpoint tests:** dedupe, policy re-check, retention-expiry computation, fail-closed behavior.
- **FTS tests:** mirror the existing `notes-fts-substrate.test.ts` pattern.
- **End-to-end test:** fake sensor → ingest → `search_ambient_context` round trip.

## 12. Expected implementation shape

This spec describes one coherent feature, but it naturally spans multiple milestones the way the rest of obsidian-tc's own M0–M7 build did: core pipeline + one platform (macOS, the most mature accessibility API for this use case) first, proving out redaction/dedupe/retention/tool-surface end to end, then Windows and Linux as additive platform backends behind the same thin native-primitive interface (§4.2). The implementation plan should sequence it this way rather than attempting all three platforms simultaneously.

## 13. Open items for the implementation plan

- Exact wire format / versioning scheme for `/ambient/v1/*` (mirror the Obsidian companion's `/obsidian-tc/v1/` versioning approach).
- Default seed list for `ambient_app_policy` (password managers, banking apps, by bundle id/executable pattern, per platform).
- Whether `admin:ambient` purge operations need their own audit-event subtype beyond the standard `event_log` row.
- CLI UX for `sensor install` / `sensor pause` / `sensor status`.
- THE-XXX ticket numbering, to be assigned during implementation planning per the project's existing convention.
