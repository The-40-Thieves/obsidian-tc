#!/usr/bin/env node
// THE-667: count and classify silent catch blocks in packages/server/src.
//
// This exists because the ticket's own scan script did not. THE-667 was filed with a regex floor
// ("65 of 179"), re-counted with ast-grep on 2026-07-30 ("81 of 242"), and both times the script
// lived in a session scratchpad that no longer exists. A re-count on 2026-08-01 therefore had to
// reconstruct the method from the ticket's prose and landed on 67 of 248 — a numerator gap that
// cannot be attributed to the code, because it is not the same program. That ambiguity is the
// whole reason this file is committed: an unrepeatable measurement is not a measurement.
//
// NOT A GATE, and deliberately not wired into any workflow. THE-667's central finding is that MOST
// silent catches are CORRECT — an optional probe, a best-effort cleanup, a telemetry sink that must
// never break dispatch. scheduler.ts's sink guards carry an explicit
// `/* persist-error sink must never throw */` and are correct by construction. A gate here would
// fire on good code forever, and blanket-instrumenting the hits would produce log noise that trains
// people to ignore the log — the same end state as no signal, reached from the opposite direction.
// It reports; a human triages.
//
// What makes a silent catch actually dangerous (THE-665/666 gave the test) is all three of:
//   1. the operation has a PERSISTENT failure mode, not a one-off race;
//   2. nothing downstream would independently reveal it;
//   3. the caller PROCEEDS AS IF IT SUCCEEDED.
// The scheduler hit all three: bun:sqlite NULLed every bind, the write failed every tick, the catch
// discarded it, and the timer loop carried on. Worse still is a catch that returns a VALID DOMAIN
// VALUE — `seedNextRun` returning null, where null is also the legitimate "no stored schedule"
// answer — because that manufactures a wrong answer the caller acts on confidently.
// This script cannot evaluate those three conditions. It narrows 248 blocks to the ~67 worth reading.
//
// Two classifications, because they answer different questions:
//   strictly inert   — body is empty once comments are stripped. Discards the error, full stop.
//   broadly no-signal— body mentions no throw / log / report / metric / channel. A superset.
//
// Both `catch {` and `catch (e) {` are scanned. Only the second CAN reference the error, and
// conflating them is how the original regex floor went wrong in both directions at once.
//
// Shell-free: ast-grep is invoked via execFileSync with an argument array, never through a shell.
import { execFileSync } from "node:child_process";

const SRC = "packages/server/src";

// Both forms, anchored on `try` so a bare `catch` token in a string or comment cannot match.
const PATTERNS = ["try { $$$A } catch { $$$B }", "try { $$$A } catch ($E) { $$$B }"];

// A body "signals" if it mentions any of these. Deliberately GENEROUS: the goal is to isolate the
// blocks that do nothing at all, so anything resembling a channel counts as signal and drops out.
// Over-matching here shrinks the report; under-matching would pad it with false positives.
const SIGNAL =
  /\b(throw|console\.|log|logger|warn|error|report|record|emit|metric|counter|inc|observe|onPersistError|onError|track|notify|capture|span|trace|audit)\b/i;

/** ast-grep, or a loud failure. A scan that silently reports zero because its tool is missing is
 *  worse than no scan — it reads as "clean". */
function astGrep(pattern) {
  let out;
  try {
    out = execFileSync("ast-grep", ["run", "-p", pattern, "-l", "ts", "--json", SRC], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    if (e?.code === "ENOENT") {
      console.error("scan-silent-catches: ast-grep is not on PATH. Install it (mise) and re-run.");
      console.error("Refusing to report a count this script did not actually measure.");
      process.exit(2);
    }
    // ast-grep exits non-zero on "no matches", which is a real result, not an error.
    out = e?.stdout ?? "";
  }
  return JSON.parse(out || "[]");
}

/** The catch body: everything inside the braces following the LAST `catch` token in the match.
 *  Taking the last one matters for nested try/catch, where the outer match contains both. */
function bodyOf(text) {
  const i = text.lastIndexOf("catch");
  if (i === -1) return "";
  const seg = text.slice(i);
  const open = seg.indexOf("{");
  return open === -1 ? "" : seg.slice(open + 1, seg.lastIndexOf("}"));
}

const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .trim();

const found = new Map();
for (const pattern of PATTERNS) {
  const bound = pattern.includes("$E");
  for (const m of astGrep(pattern)) {
    const key = `${m.file}:${m.range.start.line}:${m.range.end.line}`;
    // The bound form is the more specific match; let it win when both cover the same span.
    if (found.has(key) && !bound) continue;
    found.set(key, { file: m.file, line: m.range.start.line + 1, body: bodyOf(m.text) });
  }
}

const inert = [];
const noSignal = [];
for (const r of found.values()) {
  const stripped = stripComments(r.body);
  if (stripped === "") {
    inert.push(r);
    noSignal.push(r);
  } else if (!SIGNAL.test(stripped)) {
    noSignal.push(r);
  }
}

// A scan that matched nothing is far more likely to be broken than to be good news — ast-grep's
// pattern syntax is version-sensitive, and a silently-empty result reads identically to a clean
// tree. There are hundreds of catch blocks in this package; zero means the query stopped working.
if (found.size === 0) {
  console.error("scan-silent-catches: 0 catch blocks matched — the ast-grep pattern is broken.");
  console.error("A tree this size has hundreds. Refusing to report a clean result.");
  process.exit(2);
}

const byFile = new Map();
for (const r of inert) byFile.set(r.file, (byFile.get(r.file) ?? 0) + 1);

console.log(`scan-silent-catches: ${found.size} catch blocks in ${SRC}`);
console.log(`  strictly inert (empty after stripping comments): ${inert.length}`);
console.log(`  broadly no-signal (superset):                    ${noSignal.length}`);
console.log("\ndensest clusters (strictly inert):");
for (const [file, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(n).padStart(3)}  ${file}`);
}
console.log("\nMost of these are correct. Triage against the three conditions in the header;");
console.log("do not instrument in bulk. See THE-667.");
