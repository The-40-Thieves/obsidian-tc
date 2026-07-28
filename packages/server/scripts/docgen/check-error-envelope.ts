// docgen — error-envelope drift gate (THE-470 item 2).
//
// WHY A GATE AND NOT A GENERATOR. api-reference.md is overwhelmingly worked JSON-RPC examples and
// judgement prose — the kind of surface THE-470 explicitly says should stay hand-written. Measured
// against main @ cd61e6f, every derivable fact on it was CORRECT: "three meta-tools" (triadTools()
// = 3), "about a dozen domain tools" (TOOL_DOMAINS = 13), all four cited error codes real.
//
// One thing on it is fragile rather than wrong: the example error envelope hand-copies the
// `acl_denied` recovery string BYTE-FOR-BYTE from `recoveryFor()`. Correct today, silently stale the
// first time someone rewords the hint — the "prose that restates a generated fact" failure this
// repo keeps re-finding. THE-470 names the remedy for exactly this class: "handled by deterministic
// gates rather than by generation. That was the right answer and it is already shipped." So this is
// a gate, not a fourth renderer.
//
// WHAT IT CHECKS. Every fenced JSON block in the docs tree that looks like an error envelope (has a
// "code" plus at least one of message/retryable/recovery) is validated field-by-field against the
// live taxonomy: the code must exist, and any message/retryable/recovery it states must match what
// the server would actually send.
//
//   bun scripts/docgen/check-error-envelope.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type ErrorCode, err, recoveryFor } from "@the-40-thieves/obsidian-tc-shared";
import { narrativeFiles } from "./facts-check";

export interface EnvelopeViolation {
  file: string;
  code: string;
  field: string;
  documented: string;
  actual: string;
}

interface Envelope {
  code?: unknown;
  message?: unknown;
  retryable?: unknown;
  recovery?: unknown;
}

/** Live taxonomy, keyed by code: the default message and retryable flag each factory produces. */
function taxonomy(): Map<string, { message: string; retryable: boolean }> {
  const out = new Map<string, { message: string; retryable: boolean }>();
  for (const factory of Object.values(err as Record<string, unknown>)) {
    if (typeof factory !== "function") continue;
    const e = (factory as () => { code: string; message: string; retryable?: boolean })();
    if (!out.has(e.code)) out.set(e.code, { message: e.message, retryable: e.retryable === true });
  }
  return out;
}

/**
 * Pull every fenced ```json block that parses AND looks like an error envelope.
 *
 * Deliberately shape-based rather than filename-based: a new page pasting an envelope is exactly
 * the case this needs to catch, and keying on a file list would miss it. Blocks that do not parse
 * are skipped rather than failed — plenty of doc JSON is illustrative and intentionally elided
 * (`"details": { "path": "…" }`), and this gate is about field VALUES, not JSON hygiene.
 */
export function findEnvelopes(text: string): Envelope[] {
  const out: Envelope[] = [];
  for (const m of text.matchAll(/```json\n([\s\S]*?)```/g)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1] as string);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const o = parsed as Envelope;
    if (typeof o.code !== "string") continue;
    if (o.message === undefined && o.retryable === undefined && o.recovery === undefined) continue;
    out.push(o);
  }
  return out;
}

export function checkEnvelope(file: string, e: Envelope): EnvelopeViolation[] {
  const tax = taxonomy();
  const code = String(e.code);
  const known = tax.get(code);
  if (!known) {
    return [
      { file, code, field: "code", documented: code, actual: "(no such code in the taxonomy)" },
    ];
  }
  const out: EnvelopeViolation[] = [];
  if (typeof e.message === "string" && e.message !== known.message) {
    out.push({ file, code, field: "message", documented: e.message, actual: known.message });
  }
  if (typeof e.retryable === "boolean" && e.retryable !== known.retryable) {
    out.push({
      file,
      code,
      field: "retryable",
      documented: String(e.retryable),
      actual: String(known.retryable),
    });
  }
  if (typeof e.recovery === "string") {
    const real = recoveryFor(code as ErrorCode);
    if (e.recovery !== real) {
      out.push({
        file,
        code,
        field: "recovery",
        documented: e.recovery,
        actual: real ?? "(no hint declared for this code)",
      });
    }
  }
  return out;
}

/**
 * Floor. A scan that finds zero envelopes is a broken matcher, not a clean docs tree — the same
 * silent-empty-scan failure render.ts and facts-check.ts both refuse. Measured at the time of
 * writing: 1 envelope (api-reference.md). The floor is 1, not 1-of-N, because a second envelope
 * appearing is the case this gate exists to cover and must not be a reason to fail.
 */
const FLOOR_ENVELOPES = 1;

function main(): void {
  const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
  const files = narrativeFiles(repoRoot);
  const violations: EnvelopeViolation[] = [];
  let found = 0;

  // narrativeFiles() yields REPO-RELATIVE paths — join before reading. The first draft here read
  // them as-is; every read threw ENOENT into the catch below and the sweep examined nothing while
  // exiting 0-shaped. facts-check.ts warns about precisely this ("every read here is wrapped in a
  // catch, so a bad root scans nothing"), and the floor below is what actually caught it.
  for (const rel of files) {
    let text: string;
    try {
      text = readFileSync(`${repoRoot}/${rel}`, "utf8");
    } catch {
      continue;
    }
    for (const e of findEnvelopes(text)) {
      found += 1;
      violations.push(...checkEnvelope(rel, e));
    }
  }

  if (found < FLOOR_ENVELOPES) {
    console.error(
      `check-error-envelope: found ${found} error-envelope JSON block(s) across ${files.length} ` +
        `narrative files (floor ${FLOOR_ENVELOPES}). The matcher is broken, not the docs — ` +
        "refusing to report success over a scan that examined nothing.",
    );
    process.exit(1);
  }

  if (violations.length > 0) {
    console.error(
      `check-error-envelope: ${violations.length} documented error field(s) disagree with the live taxonomy:\n${violations
        .map(
          (v) =>
            `  ${v.file} — ${v.code}.${v.field}\n      docs: ${v.documented}\n      real: ${v.actual}`,
        )
        .join("\n")}\n` +
        "Update the doc to match, or change the taxonomy if the doc is what is right.",
    );
    process.exit(1);
  }

  console.log(
    `check-error-envelope OK — ${found} envelope(s) across ${files.length} narrative files agree with the taxonomy`,
  );
}

if (import.meta.main) main();
