// GH #994 — Memory Defense: the ONE enforcement point every memory-writing tool calls before
// persistence (see SECURITY.md's "Memory defense"). Uses the shared redactSecrets/scanPii
// (./redact) that the episode log, trace capture, and import-ambient already share.
import { err, type VaultMemoryDefenseConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { MetricsRecorder } from "../metrics/registry";
import { redactSecrets, scanPii } from "./redact";

/** The fully-defaulted config a vault with no `memoryDefense` block gets — scanning never runs,
 *  which is the "no behaviour change for existing installs" requirement made concrete. */
export const MEMORY_DEFENSE_OFF: VaultMemoryDefenseConfig = { mode: "off", pii: false };

/** check:duplicate-exports: tools/m5/shared.ts and tools/m8/shared.ts each re-export this,
 *  generic over any Deps object carrying the one optional `memoryDefense(vaultId)` closure. */
export function memoryDefenseFor<
  D extends { memoryDefense?: (vaultId: string) => VaultMemoryDefenseConfig },
>(deps: D, vaultId: string): VaultMemoryDefenseConfig {
  return deps.memoryDefense?.(vaultId) ?? MEMORY_DEFENSE_OFF;
}

/** GH #994 follow-up: the per-vault `memoryDefense(vaultId)` closure straight off
 *  `config.vaults`, for a caller (server-runtime.ts's M1 wiring) that runs before `wireBridges`
 *  builds its own `memoryDefenseByVault` map for the same config. */
export function buildMemoryDefenseLookup(
  vaults: readonly { id: string; memoryDefense?: VaultMemoryDefenseConfig }[],
): (vaultId: string) => VaultMemoryDefenseConfig {
  const byVault = new Map<string, VaultMemoryDefenseConfig>();
  for (const v of vaults) if (v.memoryDefense) byVault.set(v.id, v.memoryDefense);
  return (vaultId) => byVault.get(vaultId) ?? MEMORY_DEFENSE_OFF;
}

// `labeled_secret` (redact.ts) is deliberately permissive — any `key/token/secret/password[=:]`
// + 8+ non-space chars, so a false negative there is a leaked credential in a debug log.
// memoryDefense instead splits a hit into two confidence tiers: HIGH (isSecretShapedValue below)
// stays block-worthy; LOW is always redacted but never block-worthy alone (SECURITY.md).
const LABELED_SECRET_VALUE_RE =
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)\s*[=:]\s*["']?([^\s"',;]{8,})/gi;

// Canonical UUID shape — excluded below: a UUID next to a `token:`/`id:` label is routinely a
// correlation id, not a credential.
const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Canonical ULID shape (Crockford base32, 26 chars) — same rationale as UUID_SHAPE_RE. No `/i`:
// case-insensitive matching would misclassify a real 26-char mixed-case secret as a low-confidence ULID.
const ULID_SHAPE_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// Shannon entropy floor for the length>=20 branch, chosen with codecalc against
// test/memory-defense.test.ts fixtures: natural language ~3.72 bits/char vs random hex ~4.00; 3.8 sits strictly between, margin either side.
const LABELED_SECRET_ENTROPY_FLOOR_BITS_PER_CHAR = 3.8;

/** Shannon entropy of `value` in bits per character — a fast, dependency-free proxy for "does
 *  this look like random token material", gating only the length>=20 branch below. */
function shannonBitsPerChar(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const n = value.length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / n;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** High confidence under EITHER test: (a) >=16 chars AND >=3 of {lower, upper, digit, other
 *  excluding `-`/`_`}, or (b) >=20 chars AND above the entropy floor. A UUID or ULID is excluded
 *  from both branches regardless of length or entropy — either shape is a correlation id. */
function isSecretShapedValue(value: string): boolean {
  if (UUID_SHAPE_RE.test(value) || ULID_SHAPE_RE.test(value)) return false;
  if (value.length < 16) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9_-]/].filter((re) =>
    re.test(value),
  ).length;
  if (classes >= 3) return true;
  return (
    value.length >= 20 && shannonBitsPerChar(value) >= LABELED_SECRET_ENTROPY_FLOOR_BITS_PER_CHAR
  );
}

// Residual fix (finding 3): mutating the joined text to neutralize a cross-boundary
// `labeled_secret` match used to blind a genuine `private_key` match sharing those bytes
// (`token:\n-----BEGIN` is itself an 11-char cross-boundary hit). Excluded from the array-join
// scan instead — every OTHER pattern runs on the untouched join.
const JOIN_SCAN_EXCLUDED_PATTERN_IDS = ["labeled_secret"] as const;

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

// Zero-width/invisible-formatting codepoints an adversary can splice into a secret-shaped value
// to defeat every pattern without changing what a human sees — none reached by NFKC folding;
// stripped before scanning only. Widened over several rounds: ZWSP..ZWJ/word joiner/BOM
// originally, then LTR/RTL marks, invisible math operators, bidi controls, SOFT HYPHEN,
// MONGOLIAN VOWEL SEPARATOR, and (residual fix) ARABIC LETTER MARK (U+061C), COMBINING GRAPHEME
// JOINER (U+034F), and VARIATION SELECTORs (U+FE00-FE0F). Exported (hex) for the test sweep.
export const INVISIBLE_SPLICE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2060, 0x2064],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
];

function buildInvisibleSpliceRegex(ranges: ReadonlyArray<readonly [number, number]>): RegExp {
  const body = ranges
    .map(([lo, hi]) =>
      lo === hi ? `\\u{${lo.toString(16)}}` : `\\u{${lo.toString(16)}}-\\u{${hi.toString(16)}}`,
    )
    .join("");
  return new RegExp(`[${body}]`, "gu");
}

const ZERO_WIDTH_RE = buildInvisibleSpliceRegex(INVISIBLE_SPLICE_RANGES);

/** NFKC + zero-width strip, applied ONLY to the copy of `value` used for pattern matching —
 *  defeats a homoglyph normalization or invisible-character split used to sneak a secret past
 *  every literal-character-class regex in redact.ts. `leafOutput` (below) persists this text only
 *  when something matched, so a clean leaf's original bytes are untouched. */
function normalizeForScan(value: string): string {
  return value.normalize("NFKC").replace(ZERO_WIDTH_RE, "");
}

function scanLeafString(
  value: string,
  pii: boolean,
  excludeIds: readonly string[] = [],
): LeafScanResult {
  const normalized = normalizeForScan(value);
  let secrets = redactSecrets(normalized, excludeIds.length ? { excludeIds } : undefined);
  const ids = Object.keys(secrets.matches);
  let blockWorthy = true;
  if (
    ids.length === 1 &&
    ids[0] === "labeled_secret" &&
    allLabeledSecretMatchesLowConfidence(normalized)
  ) {
    blockWorthy = false;
    // Same redacted text/count `redactSecrets` already produced — only the pattern id changes.
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
  // A PII hit is always full-confidence, block-worthy even over a low-confidence labeled_secret.
  return {
    text: piiHits.text,
    redactions: secrets.redactions + piiHits.redactions,
    matches,
    blockWorthy: blockWorthy || piiHits.redactions > 0,
  };
}

/** A number/bigint leaf is stringified and scanned exactly like a string leaf, so a Luhn-valid
 *  card typed as a JSON numeric literal is caught the same as a quoted one. Booleans and null are
 *  still deliberately skipped — neither can carry a credential or PII shape. */
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
  /** Display paths of every field/element/key that matched — built ONLY from array indices and
   *  the already-redacted KEY text, never a leaf VALUE, so a path can never echo a secret. */
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

/** Recursively scans every string LEAF, number/bigint LEAF, and object KEY under `value`,
 *  tagging `path` (dotted for keys, `[i]` for array indices) on anything that matches. A matched
 *  KEY is represented only by its OWN scanned (redacted) form, never its raw text — closing the
 *  case where the secret is used AS a key. Booleans/null/undefined pass through unscanned. */
// A matched leaf's `text` is already the redacted form whether high or low confidence, so using
// it whenever something matched is correct either way: in `block` mode a HIGH-confidence match
// throws below anyway (value discarded); a LOW-confidence-only match proceeds redacted.
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
    const items = value.map((item, i) => walk(item, `${path}[${i}]`, ctx));
    // Also scans the array's own PERSISTED joined form (strings "\n"-joined per
    // entities.ts's serializeObservations; numbers concatenated) — catches a secret split across
    // elements, excluding `labeled_secret` (JOIN_SCAN_EXCLUDED_PATTERN_IDS, above). Mixed-type/
    // single-element arrays are skipped: nothing to reassemble.
    if (value.length > 1) {
      const allStrings = value.every((v) => typeof v === "string");
      const allNumeric = value.every((v) => typeof v === "number" || typeof v === "bigint");
      const joined = allStrings
        ? (value as string[]).join("\n")
        : allNumeric
          ? (value as Array<number | bigint>).map(String).join("")
          : null;
      if (joined !== null) {
        const scanned = scanLeafString(joined, ctx.pii, JOIN_SCAN_EXCLUDED_PATTERN_IDS);
        if (scanned.redactions > 0) {
          const joinPath = `${path}[]`;
          if (scanned.blockWorthy) recordHit(ctx, joinPath, scanned.matches);
          else recordLowConfidenceHit(ctx, scanned.matches);
          // Sever the reassembled secret in redact-mode output; block mode discards this anyway.
          return value.map(() => "[REDACTED]");
        }
      }
    }
    return items;
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
   *  mode or when nothing block-worthy matched in `block` mode. In `redact` mode (and for any
   *  low-confidence-only leaf even under `block`), every match is replaced by "[REDACTED]". */
  fields: Record<string, unknown>;
  /** Total matches across every field. Can be > 0 in `block` mode — a low-confidence hit redacts
   *  without refusing. Callers should surface this whenever nonzero. */
  redactions: number;
}

/**
 * Scan every field in `fields` and enforce the vault's memoryDefense policy before the caller
 * persists anything. Recurses into arrays/nested objects and scans object KEYS as well as leaves.
 *
 * `off`: returns unchanged. `redact`: matches replaced by "[REDACTED]". `block`: throws
 * `secret_detected` (naming pattern ids + field PATHS, never a value) when anything BLOCK-WORTHY
 * matches; a low-confidence-only leaf is redacted, not refused. Fails CLOSED: a scanner exception
 * refuses the write rather than silently persisting unscanned content.
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
 * The shared guard for every GENERIC note-mutation tool (write_note, append_note, patch_note —
 * `notes/write.ts`), not just the structured M5/M8 writers above. Scans the note's FINAL
 * persisted body, after every transform, so a secret assembled from two clean halves, or one a
 * patch introduces, is still caught.
 *
 * `path` is refused via `refusePathIfSecretShaped` BEFORE the content scan — as caller-controlled
 * as move_note/copy_note's `to`; previously scanned only via the discarded half of
 * `enforceMemoryDefense`, so `redact` mode never refused it.
 *
 * Deliberately vault-wide once `mode !== "off"`, same policy `commit_capture` applies to an
 * arbitrary `target_path`. See SECURITY.md's "Memory defense" for the measured scan cost.
 */
export function enforceMemoryDefenseOnNoteWrite(
  config: VaultMemoryDefenseConfig | undefined,
  path: string,
  content: string,
  opts: { metrics?: MetricsRecorder } = {},
): { content: string; redactions: number } {
  if ((config?.mode ?? "off") === "off") return { content, redactions: 0 };
  refusePathIfSecretShaped(config, "path", path, opts);
  const scan = enforceMemoryDefense(config, { content }, opts);
  return { content: scan.fields.content as string, redactions: scan.redactions };
}

/**
 * A raw-scanned value (already run through `enforceMemoryDefense`) can be transformed AFTER the
 * scan into the form actually persisted — `sanitizeSegment` (memory/materialize.ts) turns
 * `sk:Q7w8...` into `sk-Q7w8...`, and `\bsk-` only matches the sanitized text. Re-scans
 * `transformed` under the same policy: `off` no-ops, `block` throws, `redact` returns the
 * redacted `transformed` value. No match: no-op, returns `original` unchanged.
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

/**
 * The redacted-or-unchanged form of a caller-supplied value, for a tool response that ECHOES a
 * field it also embeds into persisted content (`add_tag`'s `tag`, `rewrite_link`'s `to_target`) —
 * a redact-mode write must not hand the raw secret back in the SAME response that redacted it on
 * disk. Reuses `scanLeafString`, never throws, and takes no `MetricsRecorder` (that write already
 * counted this same match once).
 */
export function redactedEcho(config: VaultMemoryDefenseConfig | undefined, value: string): string {
  if ((config?.mode ?? "off") === "off") return value;
  const scanned = scanLeafString(value, config?.pii ?? false);
  return scanned.redactions > 0 ? scanned.text : value;
}

/**
 * Shared with `commit_capture`'s own inline path-hit refusal — a filesystem PATH that itself
 * matches, even under `redact` mode, is refused outright rather than silently persisted at a
 * redacted (garbled) location. Every caller that also writes CONTENT to that path
 * (move_note/copy_note's destination) uses this BEFORE the content scan/write.
 *
 * No-op in `off` mode. Throws `secret_detected` naming `label` when `path` is block-worthy OR
 * merely redaction-worthy — there is no safe redacted form for a path.
 */
export function refusePathIfSecretShaped(
  config: VaultMemoryDefenseConfig | undefined,
  label: string,
  path: string,
  opts: { metrics?: MetricsRecorder } = {},
): void {
  const mode = config?.mode ?? "off";
  if (mode === "off") return;
  // `block`-mode already throws above for a high-confidence match; what's left to catch is
  // `redact` mode and a low-confidence-only `block`-mode hit — any change is refusal-worthy here.
  const scan = enforceMemoryDefense(config, { [label]: path }, opts);
  if (scan.fields[label] === path) return;
  // Rescans the NORMALIZED path (what the walk above actually matched), not the raw one — else a
  // match found only after NFKC/zero-width normalization would rescan clean and throw pattern_ids: [].
  const rescan = redactSecrets(normalizeForScan(path));
  const patternIds = new Set(Object.keys(rescan.matches));
  if (config?.pii) for (const id of Object.keys(scanPii(rescan.text).matches)) patternIds.add(id);
  throw err.secretDetected(
    `${label} is secret-shaped; refused to persist a secret-shaped path, even in redact mode`,
    { pattern_ids: [...patternIds], fields: [label] },
  );
}
