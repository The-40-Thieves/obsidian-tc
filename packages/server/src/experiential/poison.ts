// THE-238 — pre-ingest poisoning defense for the experiential tier (layer 1 of the layered
// defense; see the 2026-07-11 re-scope). Deterministic, no model call on the capture path.
//
// Threat model (MINJA arXiv 2503.03704, systematic study arXiv 2606.04329, defense survey
// arXiv 2601.05504): auto-captured agent work is the memory-poisoning injection surface —
// pseudo-instructions and procedural directives that look benign per-entry, persist across
// sessions, and trigger later. Single-entry scanning misses ~2/3 of subtle poison
// (A-MemGuard), so this layer is deliberately scoped: catch the HIGH-PRECISION shapes
// (instruction override, persistence directives, hidden text, exfil coercion) and stamp the
// rest of the pipeline's controls; the cross-episode consistency check (layer 2) rides the
// sleep-time evaluator (THE-222), and trust-aware retrieval (layer 6) is enforced by the
// readers (THE-229 work_search, THE-237 federation fuse).
//
// MEMORY CONTRACT (THE-238 "memory contracts" control, enforced here + by readers):
//   * What may be believed: only episodes the sleep-time evaluator stamps 'eligible'.
//   * Where a belief may originate: per-channel base trust below — 'dispatch' episodes are
//     the agent's own tool traffic (moderate trust); future 'ambient'/'import' channels are
//     third-party surfaces (low trust). Channel is stamped at write and never mutable.
//   * How it may change: risk can only LOWER trust/eligibility at ingest. An episode born
//     'ineligible' (high risk) may never be auto-raised — human review only. The evaluator
//     may confirm 'pending' → 'eligible'/'ineligible', never 'ineligible' → 'eligible'.
//   * When it expires: bi-temporal valid_until governs; readers must filter expired rows.
//   * Partitioning: readers default to the writing caller's own episodes (per-agent logical
//     partitioning); cross-caller retrieval is an explicit, logged request (THE-229).
//   * The membrane is absolute: no auto-promotion from episodes to authored vault claims.

export type PoisonRisk = "none" | "suspect" | "high";

export interface PoisonAssessment {
  risk: PoisonRisk;
  /** Which signal families fired (auditable, compact — e.g. "override", "persistence"). */
  signals: string[];
}

/** Per-channel base trust (memory contract: where a belief may originate). */
export const CHANNEL_TRUST: Record<string, number> = {
  dispatch: 0.6, // the agent's own tool traffic through the registry
  ambient: 0.3, // future: ambient capture worker (THE-175)
  import: 0.2, // future: imported/external episode packs
};

/** Risk multiplier applied to the channel base (risk only ever lowers trust). */
export const RISK_TRUST_MULTIPLIER: Record<PoisonRisk, number> = {
  none: 1,
  suspect: 0.5,
  high: 0.1,
};

// Family: instruction-override / injection markers. English + the common Romance/Germanic
// forms (ignora/ignorar/ignore/ignorer/ignorez/ignorieren) — multilingual payloads are a
// documented scanning failure mode.
const OVERRIDE = [
  /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|context|prompts?|messages?)/i,
  /\bdisregard\s+(?:all\s+|any\s+)?(?:previous|prior|above|your)\s+\w{0,20}\s*(?:instructions?|rules?|guidelines?)/i,
  /\bignor(?:a|ar|e[rz]|ieren?)\b[\s\S]{0,40}\b(?:instrucciones|instructions|anweisungen)\b/i,
  /\byou\s+are\s+now\s+(?:a|an|in)\b/i,
  /\bnew\s+(?:system\s+)?instructions?\s*:/i,
  /\bsystem\s+prompt\b/i,
  /\bdeveloper\s+mode\b/i,
  /\bact\s+as\s+(?:if\s+you|a\s+|an\s+)/i,
  /\bdo\s+not\s+(?:tell|reveal|mention|disclose)\s+(?:the\s+)?(?:user|anyone)\b/i,
];

// Family: persistence / procedural directives — the "benign-looking preference drift" and
// delayed-trigger shapes that survive sessions and fire later (the class content scanners
// miss; per the re-scope these are the high-risk-for-durable-storage class).
const PERSISTENCE = [
  /\bfrom\s+now\s+on\b/i,
  /\balways\s+(?:do|use|prefer|choose|recommend|respond|answer|include)\b/i,
  /\bnever\s+(?:ask|mention|reveal|question|verify|check)\b/i,
  /\bin\s+(?:all|every)\s+future\s+(?:sessions?|responses?|conversations?)\b/i,
  /\bremember\s+(?:that\s+)?(?:the\s+user|to\s+|you\s+(?:must|should))/i,
  /\b(?:store|save|add)\s+(?:this|that|it)\s+(?:to|in)\s+(?:your\s+)?memory\b/i,
  /\bwhen(?:ever)?\s+(?:asked|you\s+are\s+asked)\s+about\b[\s\S]{0,60}\b(?:say|answer|respond|reply)\b/i,
];

// Family: hidden-text vectors (zero-width smuggling, bidi override, directive-bearing HTML
// comments, large opaque blobs — '=' allowed inside so chained base64 segments still match).
const ZERO_WIDTH = /[​-‏⁠﻿]/;
const BIDI_OVERRIDE = /[‪-‮⁦-⁩]/;
const HTML_COMMENT_DIRECTIVE =
  /<!--[\s\S]{0,400}?(?:instruction|ignore|system|prompt|always|remember)[\s\S]{0,400}?-->/i;
const OPAQUE_BLOB = /[A-Za-z0-9+/=]{160,}/;

// Family: exfiltration / tool coercion.
const EXFIL = [
  /\b(?:send|forward|post|upload|exfiltrate)\s+(?:this|that|it|the\s+\w+)\s+to\s+\S+/i,
  /\bcurl\s+(?:-\w+\s+)*https?:\/\//i,
  /https?:\/\/[^\s/]*:[^\s@]*@/i, // credentials embedded in a URL
];

// Invisible/spacing controls used to smuggle directives past a literal scan: zero-width
// (ZWSP..RLM, word-joiner, BOM/ZWNBSP) + bidi embeddings/overrides/isolates. Mirrors the
// ZERO_WIDTH + BIDI_OVERRIDE detection ranges, in explicit code points for the strip step.
const INVISIBLE_CONTROLS = /[​-‏⁠﻿‪-‮⁦-⁩]/gu;

/**
 * Canonicalize before content matching so trivial evasions collapse to their visible form:
 * NFKC folds compatibility homoglyphs (fullwidth "ｉｇｎｏｒｅ", ligatures) to ASCII, and stripping
 * the invisible controls defeats interleaved-zero-width smuggling ("i​gnore previous
 * instructions"). ASCII payloads are unchanged by NFKC + strip, so everything the raw patterns
 * already caught stays caught — this only ADDS detections (THE-238 layer-1 hardening).
 */
export function normalizeForScan(text: string): string {
  return text.normalize("NFKC").replace(INVISIBLE_CONTROLS, "");
}

/**
 * Assess one episode's textual payload. Precision-leaning by design: 'high' means an
 * instruction-override or exfil shape fired (born-ineligible); 'suspect' means persistence
 * or hidden-text shapes fired (eligible only via the evaluator); two or more suspect
 * families escalate to 'high'.
 */
export function assessPoison(text: string): PoisonAssessment {
  const signals: string[] = [];
  // Content families run against the canonicalized text (homoglyph/zero-width evasion folded away);
  // the hidden-text family runs against the ORIGINAL, since the presence of the invisibles is itself
  // the signal that normalization would erase.
  const scan = normalizeForScan(text);
  if (OVERRIDE.some((p) => p.test(scan))) signals.push("override");
  if (PERSISTENCE.some((p) => p.test(scan))) signals.push("persistence");
  const hidden =
    ZERO_WIDTH.test(text) ||
    BIDI_OVERRIDE.test(text) ||
    HTML_COMMENT_DIRECTIVE.test(scan) ||
    OPAQUE_BLOB.test(scan);
  if (hidden) signals.push("hidden");
  if (EXFIL.some((p) => p.test(scan))) signals.push("exfil");

  let risk: PoisonRisk = "none";
  if (signals.includes("override") || signals.includes("exfil")) risk = "high";
  else if (signals.length >= 2) risk = "high";
  else if (signals.length === 1) risk = "suspect";
  return { risk, signals };
}

/** Trust for an episode given its channel + assessed risk (contract: risk only lowers it). */
export function episodeTrust(channel: string, risk: PoisonRisk): number {
  const base = CHANNEL_TRUST[channel] ?? 0.2;
  return base * RISK_TRUST_MULTIPLIER[risk];
}
