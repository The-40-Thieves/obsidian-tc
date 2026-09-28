// GH #994 — Memory Defense: the ONE enforcement point every memory-writing tool calls before
// persistence (create_entity/add_observation in tools/m5/memory-tools.ts, enqueue_capture/
// commit_capture in tools/m5/capture-tools.ts, set_goal in tools/m8/goal-tools.ts).
//
// redactSecrets/scanPii (./redact) are the SAME scanner the episode log, trace capture, and
// import-ambient already share — a pattern added because it leaked through one of THOSE surfaces
// protects memory too; this module adds no second pattern list of its own.
import { err, type VaultMemoryDefenseConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { MetricsRecorder } from "../metrics/registry";
import { redactSecrets, scanPii } from "./redact";

/** The fully-defaulted config a vault with no `memoryDefense` block gets — scanning never runs,
 *  which is the "no behaviour change for existing installs" requirement made concrete. */
export const MEMORY_DEFENSE_OFF: VaultMemoryDefenseConfig = { mode: "off", pii: false };

/** check:duplicate-exports: tools/m5/shared.ts and tools/m8/shared.ts each re-export this,
 *  generic over any Deps object carrying the one optional `memoryDefense(vaultId)` closure both
 *  M5Deps and M8Deps declare, so the two modules stop carrying byte-identical local copies.
 *  M5Deps/M8Deps themselves stay separate interfaces; only this domain-neutral accessor is shared. */
export function memoryDefenseFor<
  D extends { memoryDefense?: (vaultId: string) => VaultMemoryDefenseConfig },
>(deps: D, vaultId: string): VaultMemoryDefenseConfig {
  return deps.memoryDefense?.(vaultId) ?? MEMORY_DEFENSE_OFF;
}

// `labeled_secret` (redact.ts) is deliberately permissive — ANY `key/token/secret/password[=:]`
// followed by 8+ non-space chars — because a false NEGATIVE on the trace/episode redaction paths
// it also guards is a leaked credential in a debug log. Left alone, that permissiveness makes
// `block` mode refuse ordinary memory prose ("token: deployment-id-12345"). Rather than weaken the
// shared pattern (which would weaken trace/episode redaction too), memoryDefense splits a
// `labeled_secret` hit into two confidence tiers, memoryDefense-only: HIGH — the captured value
// itself is secret-shaped (isSecretShapedValue below) — stays block-worthy under `labeled_secret`
// as before; LOW — everything else — is always redacted (never persisted verbatim) but never on
// its own grounds for a `block` refusal, counted separately under `labeled_secret_low_confidence`
// so the false-positive rate is observable. A leaf where a low-confidence hit co-occurs with any
// OTHER pattern (a real `sk-...` sitting after "token:") is unaffected — fully block-worthy.
const LABELED_SECRET_VALUE_RE =
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)\s*[=:]\s*["']?([^\s"',;]{8,})/gi;

// Canonical UUID shape (8-4-4-4-12 hex) — excluded from the secret-shape test below: a UUID next
// to a `token:`/`id:` label ("token: 123e4567-...") is routinely a correlation id, not a credential.
const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** High confidence under EITHER test: (a) >=16 chars AND >=3 of {lower, upper, digit,
 *  other-excluding-`-`/`_`} (a mixed-case/symbol token short of 20 chars), or (b) >=20 chars
 *  regardless of class mix (a long low-entropy-by-class token — 32 lowercase hex chars). `-`/`_`
 *  are excluded from "other" as ordinary prose separators, not evidence of randomness. A UUID is
 *  excluded from both branches. */
function isSecretShapedValue(value: string): boolean {
  if (UUID_SHAPE_RE.test(value)) return false;
  if (value.length < 16) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9_-]/].filter((re) =>
    re.test(value),
  ).length;
  if (classes >= 3) return true;
  return value.length >= 20;
}

/** True when EVERY `labeled_secret` match in `text` fails the secret-shape test. One
 *  high-confidence capture anywhere keeps the whole leaf block-worthy (conservative default). */
function allLabeledSecretMatchesLowConfidence(text: string): boolean {
  LABELED_SECRET_VALUE_RE.lastIndex = 0;
  let sawAny = false;
  let m: RegExpExecArray | null = LABELED_SECRET_VALUE_RE.exec(text);
  while (m !== null) {
    sawAny = true;
    if (isSecretShapedValue(m[1] ?? "")) return false;
    m = LABELED_SECRET_VALUE_RE.exec(text);
  }
  return sawAny;
}

interface LeafScanResult {
  text: string;
  redactions: number;
  matches: Record<string, number>;
  /** False ONLY for a leaf whose entire match set is low-confidence `labeled_secret` hits — that
   *  leaf is still redacted but must never contribute to a `block`-mode refusal. */
  blockWorthy: boolean;
}

function scanLeafString(value: string, pii: boolean): LeafScanResult {
  let secrets = redactSecrets(value);
  const ids = Object.keys(secrets.matches);
  let blockWorthy = true;
  if (
    ids.length === 1 &&
    ids[0] === "labeled_secret" &&
    allLabeledSecretMatchesLowConfidence(value)
  ) {
    blockWorthy = false;
    // Same redacted text/count `redactSecrets` already produced — only the pattern id changes, so
    // the metric can tell a low-confidence hit apart from a high-confidence one.
    secrets = {
      text: secrets.text,
      redactions: secrets.redactions,
      matches: { labeled_secret_low_confidence: secrets.matches.labeled_secret as number },
    };
  }
  if (!pii) return { ...secrets, blockWorthy };
  const piiHits = scanPii(secrets.text);
  const matches = { ...secrets.matches };
  for (const [id, n] of Object.entries(piiHits.matches)) matches[id] = (matches[id] ?? 0) + n;
  // A PII hit is always full-confidence — it makes the leaf block-worthy even over a low-confidence
  // labeled_secret half.
  return {
    text: piiHits.text,
    redactions: secrets.redactions + piiHits.redactions,
    matches,
    blockWorthy: blockWorthy || piiHits.redactions > 0,
  };
}

/** A number/bigint leaf (e.g. `frontmatter_overrides: { card: 4242424242424242 }`) is stringified
 *  and scanned exactly like a string leaf, so a Luhn-valid card typed as a JSON numeric literal is
 *  caught the same as a quoted one. A clean leaf keeps its original numeric type; a match
 *  necessarily returns a string ("[REDACTED]" has no numeric form). Booleans and null are still
 *  deliberately skipped — neither can carry a credential or PII shape. */
function scanNumericLeaf(
  value: number | bigint,
  pii: boolean,
): {
  text: string | number | bigint;
  redactions: number;
  matches: Record<string, number>;
  blockWorthy: boolean;
} {
  const scanned = scanLeafString(String(value), pii);
  if (scanned.redactions === 0)
    return { text: value, redactions: 0, matches: {}, blockWorthy: true };
  return scanned;
}

interface WalkCtx {
  mode: "redact" | "block";
  pii: boolean;
  hitCounts: Record<string, number>;
  /** Display paths of every field/element/key that matched — built ONLY from array indices and the
   *  already-redacted-if-necessary KEY text, never a leaf VALUE, so a path can never itself echo
   *  the secret it names. */
  matchedPaths: string[];
}

function recordHit(ctx: WalkCtx, path: string, matches: Record<string, number>): void {
  ctx.matchedPaths.push(path);
  for (const [id, n] of Object.entries(matches)) ctx.hitCounts[id] = (ctx.hitCounts[id] ?? 0) + n;
}

/** A low-confidence hit is still counted (for FP-rate observability) but never pushed onto
 *  `matchedPaths`, which is what triggers a `block`-mode refusal. */
function recordLowConfidenceHit(ctx: WalkCtx, matches: Record<string, number>): void {
  for (const [id, n] of Object.entries(matches)) ctx.hitCounts[id] = (ctx.hitCounts[id] ?? 0) + n;
}

/**
 * Recursively scan every string LEAF, every number/bigint LEAF, and every object KEY under
 * `value`, tagging `path` (dotted for object keys, `[i]` for array indices) on anything that
 * matches. Booleans/null/undefined pass through unscanned.
 *
 * A KEY that matches is represented in a path or output object only by its OWN scanned (redacted)
 * form, never its raw text — closing the case where the secret itself is the key
 * (`{ "sk-...": "value" }`), which would otherwise leak straight through `Object.keys` even though
 * every leaf VALUE was scanned correctly.
 */
// A matched leaf's `text` is already the redacted form whether the match was high or low
// confidence, so using it whenever something matched is correct either way: in `block` mode with a
// HIGH-confidence match the whole write throws below anyway (this value is discarded); with a
// LOW-confidence-only match the write proceeds and must carry the redacted text.
function leafOutput<T>(scanned: { text: T; redactions: number }, original: T): T {
  return scanned.redactions > 0 ? scanned.text : original;
}

function walk(value: unknown, path: string, ctx: WalkCtx): unknown {
  if (typeof value === "string") {
    const scanned = scanLeafString(value, ctx.pii);
    if (scanned.redactions > 0) {
      if (scanned.blockWorthy) recordHit(ctx, path, scanned.matches);
      else recordLowConfidenceHit(ctx, scanned.matches);
    }
    return leafOutput(scanned, value);
  }
  if (typeof value === "number" || typeof value === "bigint") {
    const scanned = scanNumericLeaf(value, ctx.pii);
    if (scanned.redactions > 0) {
      if (scanned.blockWorthy) recordHit(ctx, path, scanned.matches);
      else recordLowConfidenceHit(ctx, scanned.matches);
    }
    return leafOutput(scanned, value);
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => walk(item, `${path}[${i}]`, ctx));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [rawKey, v] of Object.entries(value as Record<string, unknown>)) {
      const scannedKey = scanLeafString(rawKey, ctx.pii);
      const keyMatched = scannedKey.redactions > 0;
      const outKey = leafOutput(scannedKey, rawKey);
      const childPath = path ? `${path}.${outKey}` : outKey;
      if (keyMatched) {
        if (scannedKey.blockWorthy) recordHit(ctx, childPath, scannedKey.matches);
        else recordLowConfidenceHit(ctx, scannedKey.matches);
      }
      out[outKey] = walk(v, childPath, ctx);
    }
    return out;
  }
  return value;
}

export interface MemoryDefenseOutcome {
  /** Field values to persist, same shape as the input `fields`. Identical to the input in `off`
   *  mode, or in `block` mode when nothing block-worthy matched. In `redact` mode every matched
   *  string/number leaf and matched object key is replaced by "[REDACTED]" — the caller must
   *  persist THESE values. In `block` mode a LOW-CONFIDENCE `labeled_secret`-only leaf is ALSO
   *  replaced here even though the write as a whole is not refused. */
  fields: Record<string, unknown>;
  /** Total matches across every field (0 in `off` mode, or when nothing matched). Can be > 0 in
   *  `block` mode — a low-confidence hit redacts without refusing. Callers should surface this
   *  whenever nonzero, not only when `mode === "redact"`. */
  redactions: number;
}

/**
 * Scan every field in `fields` (name -> a string/number, an array, or a nested object of them)
 * and enforce the vault's memoryDefense policy before the caller persists anything. Recurses into
 * arrays and nested objects and scans object KEYS as well as leaves, so a secret hiding in
 * `tags: ["<token>"]`, in a nested override object, or used AS a key is caught the same as a
 * top-level field.
 *
 * `off` (default): returns `fields` unchanged, never scans.
 * `redact`: returns `fields` with every match replaced by "[REDACTED]".
 * `block`: throws `secret_detected` (never retryable) naming the matched pattern ids and field
 * PATHS — never the value, and never a key's own raw text when the key matched — when anything
 * BLOCK-WORTHY matches. A leaf whose ONLY match is a low-confidence `labeled_secret` hit is NOT
 * block-worthy: it is redacted like `redact` mode would, but does not refuse the write.
 *
 * Fails CLOSED: a scanner exception on an in-scope write refuses rather than silently persisting
 * an unscanned value — a miss here persists forever; a refused write can simply be retried.
 */
export function enforceMemoryDefense(
  config: VaultMemoryDefenseConfig | undefined,
  fields: Record<string, unknown>,
  opts: { metrics?: MetricsRecorder } = {},
): MemoryDefenseOutcome {
  const mode = config?.mode ?? "off";
  if (mode === "off") return { fields, redactions: 0 };

  const ctx: WalkCtx = { mode, pii: config?.pii ?? false, hitCounts: {}, matchedPaths: [] };
  let out: Record<string, unknown>;
  try {
    out = {};
    for (const [name, value] of Object.entries(fields)) out[name] = walk(value, name, ctx);
  } catch {
    // Fail closed: never persist a field this pass could not finish scanning.
    opts.metrics?.incMemoryDefenseHits("scanner_error", 1);
    throw err.secretDetected(
      "memoryDefense scanner failed on an in-scope write; refused rather than persisting unscanned content",
      { pattern_ids: ["scanner_error"] },
    );
  }

  const totalRedactions = Object.values(ctx.hitCounts).reduce((a, b) => a + b, 0);
  for (const [id, n] of Object.entries(ctx.hitCounts)) opts.metrics?.incMemoryDefenseHits(id, n);

  if (mode === "block" && ctx.matchedPaths.length > 0) {
    throw err.secretDetected("secret-shaped content refused", {
      pattern_ids: Object.keys(ctx.hitCounts),
      fields: ctx.matchedPaths,
    });
  }
  return { fields: out, redactions: totalRedactions };
}

/**
 * A raw-scanned value (`enforceMemoryDefense` above, already run on `original`) can still be
 * transformed AFTER the scan into the form that actually gets persisted — `sanitizeSegment`
 * (memory/materialize.ts) turns `sk:Q7w8...` into `sk-Q7w8...`, and `\bsk-` only matches the
 * SANITIZED text. Scanning the raw value alone is not enough for a field whose persisted form goes
 * through a transform like that (a create_entity/rename_entity path segment, materialized into a
 * vault-relative `.md` path and echoed back as `vault_path`).
 *
 * Re-scans `transformed` (the caller passes `sanitizeSegment(original)`) under the same policy:
 *  - `off`: no-op, returns `original`.
 *  - `block`: a match on `transformed` throws `secret_detected`, same as a raw-value match — the
 *    write never reaches SQLite or the vault. No match: no-op.
 *  - `redact`: a match on `transformed` means the redacted `transformed` IS what the caller must
 *    persist going forward — the sanitized string is what actually becomes the note's path
 *    segment (and, for create_entity/rename_entity, the entity's own persisted name, since the
 *    note path is server-computed from that name). No match: no-op, returns `original` unchanged.
 */
export function enforceMemoryDefenseOnTransformed(
  config: VaultMemoryDefenseConfig | undefined,
  label: string,
  original: string,
  transformed: string,
  opts: { metrics?: MetricsRecorder } = {},
): { value: string; redactions: number } {
  if ((config?.mode ?? "off") === "off") return { value: original, redactions: 0 };
  const scan = enforceMemoryDefense(config, { [label]: transformed }, opts);
  if (scan.redactions === 0) return { value: original, redactions: 0 };
  return { value: scan.fields[label] as string, redactions: scan.redactions };
}
