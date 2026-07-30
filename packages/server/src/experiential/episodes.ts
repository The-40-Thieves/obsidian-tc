// THE-228 — the agent_episodes capture bus. Consumes the registry's onEpisode hook (one call
// per dispatch outcome, session or not) and appends one row per episode to agent_episodes in
// the experiential store. Capture-everything on the ACTION axis; the CONTENT axis (raw args)
// is gated by `captureContent` (default OFF until the THE-238 poisoning defense red-team
// gate is green) and, when on, args are secret-scanned (redaction, THE-227 constraint 1)
// and size-capped before storage. The THE-238 layer-1 poison scan runs on every capture
// regardless of content persistence, stamping tags/trust/eligibility. Rows are born
// eligibility='pending' (high poison risk -> 'ineligible') — the sleep-time evaluator
// (THE-222 pass) stamps 'pending' rows 'eligible'/'ineligible', so the log stays complete
// while retrieval-use is gated (write-on control 2 as an eligibility stamp, not a write
// block). Best-effort: a capture failure goes to onError and never breaks the dispatch.
import { randomBytes } from "node:crypto";
import type { Database } from "../db/types";
import type { DispatchEpisode } from "../mcp/registry";
import { assessPoison, episodeTrust } from "./poison";

/** Stable episode id, e.g. "ep_9f2c…". 9 random bytes = 18 hex chars. */
export function genEpisodeId(): string {
  return `ep_${randomBytes(9).toString("hex")}`;
}

// Deliberately compact, high-precision credential shapes (gitleaks-style). The scan is a
// REDACTION pass, not the poisoning defense — THE-238 layers the injection/consistency
// checks on top. Order matters only for overlap; each pattern is applied globally.
//
// THE-619 item 3: two categories were verified (empirically, by running redactSecrets against
// each candidate shape) to be genuinely missing and are added below. NOT added, because already
// covered: generic PEM private keys — `-----BEGIN [A-Z ]*PRIVATE KEY-----` already matches RSA/
// EC/DSA/OPENSSH banners regardless of the algorithm word, since `[A-Z ]*` swallows it.
//   1. DB/service connection strings with embedded credentials (`scheme://user:pass@host`) — no
//      existing pattern's label list ("api_key", "token", "password", ...) matches a bare `://`
//      URL, so a leaked connection string slipped through entirely.
//   2. Bare (unlabeled) provider API keys — the generic label pattern only fires when a
//      recognized word precedes the value; a key pasted bare (in a URL, a connection string, an
//      unlabeled config field) is invisible to it. Added the two verified-missing, well-known,
//      fixed-shape formats: Google API keys and Stripe secret/restricted keys. Deliberately
//      excludes Stripe PUBLISHABLE keys (`pk_...`) — those are meant to be public, so redacting
//      them would be a false positive that destroys non-secret data for nothing.
//
// THE-619 item 3 (continued): two more categories, same "verified genuinely missing" bar as
// above. Anthropic key patterns, `export KEY=` forms, Cohere keys, atomic groups, and ReDoS
// hardening were all considered and explicitly excluded — out of scope for this pass.
//   3. Hugging Face tokens — fixed `hf_` prefix, no existing pattern covers it (the generic
//      label pattern needs a preceding label word; a bare `hf_...` token has none).
//   4. Azure SAS tokens — no fixed prefix to anchor on (unlike AKIA/gh_/sk-/AIza above), but a
//      SAS URL always carries a `sig=<signature>` query parameter.
//
// THE-619 review fixes (this pass), against the additions above:
//   Defect 1 — `sig` was added to the generic keyword alternation (`api_key|token|password|...`)
//      to catch SAS tokens, but `sig` is too short and common a config key for that alternation:
//      it over-matched `sig: migration`, `sig=disabled`, and public (non-secret) signature
//      material. Removed from the alternation; replaced with a standalone, TARGETED SAS pattern
//      below that requires actual query-parameter context.
//   Defect 2 — that targeted pattern also has to recognize a percent-encoded SAS URL (`%3F`/
//      `%26`/`%3D` in place of `?`/`&`/`=`), which is a realistic shape on a capture path — SAS
//      URLs commonly arrive pre-encoded inside a JSON args payload.
//   Defect 3 — the `hf_` pattern's trailing `\b` failed whenever the token was adjacent to `_`
//      (`_` is a word character, so `\b` does not fire at a `hf_...` / `..._` boundary), which
//      is a false negative / leak, not a cosmetic near-miss: a token wrapped in markdown
//      emphasis (`_hf_..._`) or trailing an env-style `_` slipped through uncaught. Replaced
//      both boundaries with lookaround anchored on the token's own alphabet
//      (`[A-Za-z0-9]`) instead of `\b`, so it deliberately still matches when adjacent to `_` —
//      for a redactor, over-matching a secret is the safe direction.
//   Defect 4 — upstream Gitleaks models `hf_` tokens as exactly 34 alphanumeric chars; this file
//      deliberately keeps the permissive `{30,}` floor rather than tightening to `{34}` (HF has
//      not published a stable shape, and a false negative here leaks a live credential while a
//      false positive only costs one redacted string) — see the pattern below.
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub fine/classic tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bsk-[A-Za-z0-9_-]{20,}\b/g, // OpenAI-style secret keys
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, // JWT
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/g,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)\s*[=:]\s*["']?[^\s"',;]{8,}/gi,
  // DB/service connection string with embedded user:pass — common schemes only (not a generic
  // `scheme://user:pass@host` catch-all, which would over-match arbitrary URLs unrelated to
  // credential storage).
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|mssql):\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/gi,
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key (fixed 39-char shape)
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, // Stripe secret/restricted key (not pk_ — publishable is not a secret)
  // Hugging Face token: `hf_` + 30+ alphanumeric. Boundaries are lookaround on the token's own
  // alphabet, not `\b` — `_` is a word character, so a trailing/leading `_` (env-style
  // `hf_...token..._`, or markdown emphasis `_hf_..._`) would silently defeat a `\b`-anchored
  // match (THE-619 defect 3). `{30,}` is a deliberately permissive floor, not the exact 34-char
  // shape Gitleaks models upstream — HF has not published a stable length, and for a redactor a
  // false negative (leaked live credential) is far worse than a false positive (one redacted
  // string) (THE-619 defect 4).
  /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{30,}(?![A-Za-z0-9])/g,
  // Azure SAS token: a `sig=` (or percent-encoded `sig%3D`) query parameter, anchored on real
  // query-string context (`?`/`&`, or their percent-encoded forms `%3F`/`%26` for a SAS URL
  // that has itself been percent-encoded whole — a realistic shape when it arrives inside a
  // JSON args payload on a capture path, THE-619 defect 2). A bare `sig: <value>` with no
  // query-parameter delimiter — e.g. `sig: migration`, `sig=disabled`, or public signature
  // material — is deliberately NOT matched; `sig` is too short/common a key to sit in the
  // generic labeled-value alternation above (THE-619 defect 1, replacing the earlier
  // `sig`-in-alternation approach). Length floor 40: a SAS signature is a Base64-encoded
  // HMAC-SHA256 digest, a fixed 44 chars (32 bytes -> 11 base64 groups + one `=` pad); 40 sits
  // just under that to tolerate percent-encoding of the value itself without hardcoding the
  // exact literal count.
  /(?:[?&]|%3F|%26)sig(?:=|%3D)(?:[A-Za-z0-9+/_-]|%2B|%2F|%3D){40,}/gi,
];

const REDACTED = "[REDACTED]";

/** Redact credential-shaped substrings. Returns the scrubbed text + how many hits. */
export function redactSecrets(text: string): { text: string; redactions: number } {
  let out = text;
  let redactions = 0;
  for (const pat of SECRET_PATTERNS) {
    out = out.replace(pat, () => {
      redactions += 1;
      return REDACTED;
    });
  }
  return { text: out, redactions };
}

export interface EpisodeCaptureOptions {
  now?: () => number;
  onError?: (err: unknown) => void;
  /** Persist scanned + capped raw args JSON. Default false — the content axis stays off
   *  until THE-238's poisoning defense lands (write-on gate ordering). */
  captureContent?: boolean;
  /** Byte cap on stored args_json AFTER redaction (default 4096). */
  maxArgsBytes?: number;
}

export type EpisodeSink = (e: DispatchEpisode) => void;

/**
 * Build the append-only episode sink over an open experiential.db handle. One insert per
 * dispatch outcome; never throws. Maintains a process-local per-caller chain (prev_id) so
 * consolidation can walk a caller's episodes in order without sorting the whole table.
 */
export function createEpisodeCapture(edb: Database, opts: EpisodeCaptureOptions = {}): EpisodeSink {
  const insert = edb.prepare(
    `INSERT INTO agent_episodes (
       id, ts, vault_id, session_id, caller, channel, episode_type, tool, status, error_code,
       duration_ms, result_size, args_hash, args_json, secret_scan, tags, trust, eligibility,
       valid_from, prev_id
     ) VALUES (?, ?, ?, ?, ?, 'dispatch', 'tool_call', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const maxArgsBytes = opts.maxArgsBytes ?? 4096;
  // THE-654: prevByCaller is a process-local CACHE over the durable chain, not the chain itself.
  // A miss used to mean "no previous episode" outright, which broke the amendment chain at every
  // restart — the Map starts empty on boot, so the first episode captured per caller after a
  // restart got prev_id NULL even when that caller has years of history sitting in the table.
  // idx_agent_episodes_caller(caller, ts DESC) makes the fallback query below an index-covered
  // point lookup, so the cache exists purely to skip it on the hot (same-process, same-caller)
  // path rather than for correctness.
  const prevByCaller = new Map<string, string>();
  // `caller IS ?` (not `=`) so a NULL caller is looked up as NULL rather than never matching —
  // the same null-safe idiom experiential-tools.ts already uses for this column. `rowid DESC`
  // breaks a same-millisecond tie in actual insertion order, mirroring activation.ts's use of
  // rowid as a tiebreaker over the same wall clock.
  const selectLastByCaller = edb.prepare(
    "SELECT id FROM agent_episodes WHERE caller IS ? ORDER BY ts DESC, rowid DESC LIMIT 1",
  );

  return (e) => {
    try {
      const id = genEpisodeId();
      const ts = (opts.now ?? Date.now)();
      // THE-238 layer 1: the poison scan runs on the payload IN MEMORY regardless of whether
      // content is persisted — risk stamps eligibility/trust even when args_json stays null.
      const raw = JSON.stringify(e.args ?? null);
      const poison = assessPoison(raw);
      let argsJson: string | null = null;
      let scan = "off";
      if (opts.captureContent === true) {
        const { text, redactions } = redactSecrets(raw);
        argsJson = text.length > maxArgsBytes ? `${text.slice(0, maxArgsBytes)}…[truncated]` : text;
        scan = redactions > 0 ? `redacted:${redactions}` : "clean";
      }
      // Memory contract: risk only lowers trust; a high-risk episode is born ineligible and
      // may never be auto-raised (human review only). Everything else is born pending for
      // the sleep-time evaluator (THE-222).
      const tags =
        poison.signals.length > 0 ? JSON.stringify(poison.signals.map((s) => `poison:${s}`)) : null;
      const trust = episodeTrust("dispatch", poison.risk);
      const eligibility = poison.risk === "high" ? "ineligible" : "pending";
      const callerKey = e.caller ?? "";
      // THE-654: a cache miss falls through to the DB instead of concluding "no previous episode".
      let prev = prevByCaller.get(callerKey) ?? null;
      if (prev === null) {
        const row = selectLastByCaller.get(e.caller) as { id: string } | undefined;
        prev = row?.id ?? null;
      }
      insert.run(
        id,
        ts,
        e.vaultId,
        e.sessionId,
        e.caller,
        e.tool,
        e.status,
        e.errorCode,
        e.durationMs,
        e.resultSize,
        e.argsHash,
        argsJson,
        scan,
        tags,
        trust,
        eligibility,
        ts,
        prev,
      );
      prevByCaller.set(callerKey, id);
    } catch (err) {
      opts.onError?.(err);
    }
  };
}
