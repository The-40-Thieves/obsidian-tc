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
  const prevByCaller = new Map<string, string>();

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
      const prev = prevByCaller.get(callerKey) ?? null;
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
