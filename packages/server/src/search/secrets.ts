// Pre-embedding secret scan — THE-233 W-INGEST, ported from knowledge-mcp-server
// ingest/secrets.ts (THE-134). Scans chunk content for credential shapes BEFORE the embed
// call so a secret pasted inline in an otherwise-public note never reaches chunk_embeddings.
// On a hit the indexer skips the chunk and logs path + pattern CLASS only — the matched
// value is never returned, logged, or thrown. This module only ever reports class names.

export interface SecretScanResult {
  clean: boolean;
  /** Pattern class names that matched. Never contains matched text. */
  classes: string[];
}

interface SecretPattern {
  class: string;
  re: RegExp;
  /** When set, the first capture group must clear this Shannon-entropy bar (bits/char) to
   *  count — filters `api_key = "placeholder"`-style prose. */
  minEntropy?: number;
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const PATTERNS: SecretPattern[] = [
  {
    class: "aws_access_key_id",
    re: /\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/,
  },
  {
    class: "github_token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/,
  },
  { class: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { class: "private_key_block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    class: "vendor_prefixed_key",
    re: /\b(?:sk-[A-Za-z0-9_-]{20,}|[sp]k_(?:live|test)_[A-Za-z0-9]{16,})\b/,
  },
  { class: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    class: "generic_key_assignment",
    re: /\b(?:api|secret|access|auth|service)[_-]?(?:key|token|secret)["']?\s*[:=]\s*["']?([A-Za-z0-9+/_.-]{20,})/i,
    minEntropy: 3.5,
  },
  {
    class: "connection_string_credential",
    re: /\b[a-z][a-z0-9+]{1,30}:\/\/[^\s:/@]+:([^\s/@]{8,})@/i,
    minEntropy: 3.0,
  },
];

/** Scan content for credential shapes. Returns matched pattern CLASSES only, never text. */
export function scanSecrets(content: string): SecretScanResult {
  const classes: string[] = [];
  for (const p of PATTERNS) {
    const m = p.re.exec(content);
    if (!m) continue;
    if (p.minEntropy !== undefined) {
      const candidate = m[1] ?? "";
      if (shannonEntropy(candidate) < p.minEntropy) continue;
    }
    classes.push(p.class);
  }
  return { clean: classes.length === 0, classes };
}
