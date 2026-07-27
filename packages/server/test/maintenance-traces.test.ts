// THE-610: the maintenance sweep's first FILESYSTEM arm. Every other sweep count is rows in
// cache.db; this one deletes files inside a user's vault, so the tests are deliberately more
// paranoid than the row-delete ones — what it REFUSES to touch matters as much as what it prunes.
import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sweepTraceFiles } from "../src/db/maintenance";
import { appendTrace, resolveTraceDirs, traceRelPath } from "../src/workspace/sessions";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

/** A trace dir with files aged in days-before-NOW. */
function makeDir(files: Record<string, number>): string {
  const dir = mkdtempSync(join(tmpdir(), "tc-traces-"));
  for (const [name, ageDays] of Object.entries(files)) {
    const p = join(dir, name);
    writeFileSync(p, '{"ts":1}\n', "utf8");
    const t = (NOW - ageDays * DAY) / 1000;
    utimesSync(p, t, t);
  }
  return dir;
}

describe("sweepTraceFiles (THE-610)", () => {
  it("prunes traces older than the retention window and keeps newer ones", () => {
    const dir = makeDir({ "sess_old.jsonl": 45, "sess_edge.jsonl": 31, "sess_new.jsonl": 2 });
    const n = sweepTraceFiles([{ vaultId: "v1", dir }], { now: NOW, tracesDays: 30 });
    // NON-EMPTY FLOOR: the whole point is watching it actually delete. A sweep that matches
    // nothing reports success forever — see [[feedback-verify-checks-cover-their-domain]].
    expect(n).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(["sess_new.jsonl"]);
  });

  it("dryRun counts what would go without deleting anything", () => {
    const dir = makeDir({ "sess_a.jsonl": 90, "sess_b.jsonl": 90 });
    const n = sweepTraceFiles([{ vaultId: "v1", dir }], {
      now: NOW,
      tracesDays: 30,
      dryRun: true,
    });
    expect(n).toBe(2);
    expect(readdirSync(dir)).toHaveLength(2); // still there
    // and a real pass afterwards removes exactly what the dry run promised
    expect(sweepTraceFiles([{ vaultId: "v1", dir }], { now: NOW, tracesDays: 30 })).toBe(2);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("touches only *.jsonl, and never recurses", () => {
    const dir = makeDir({ "sess_a.jsonl": 90, "notes.md": 90, "cache.db": 90 });
    const sub = join(dir, "nested");
    mkdirSync(sub);
    const deep = join(sub, "sess_deep.jsonl");
    writeFileSync(deep, "{}\n", "utf8");
    utimesSync(deep, (NOW - 90 * DAY) / 1000, (NOW - 90 * DAY) / 1000);

    const n = sweepTraceFiles([{ vaultId: "v1", dir }], { now: NOW, tracesDays: 30 });
    expect(n).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(["cache.db", "nested", "notes.md"]);
    expect(readdirSync(sub)).toEqual(["sess_deep.jsonl"]); // a nested trace is NOT swept
  });

  it("a vault that has never started a session is a no-op, not an error", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "tc-traces-")), "never-created");
    expect(sweepTraceFiles([{ vaultId: "v1", dir }], { now: NOW, tracesDays: 30 })).toBe(0);
  });

  it("sweeps every vault it is given", () => {
    const a = makeDir({ "sess_a.jsonl": 90 });
    const b = makeDir({ "sess_b.jsonl": 90, "sess_keep.jsonl": 1 });
    const n = sweepTraceFiles(
      [
        { vaultId: "v1", dir: a },
        { vaultId: "v2", dir: b },
      ],
      { now: NOW, tracesDays: 30 },
    );
    expect(n).toBe(2);
    expect(readdirSync(a)).toHaveLength(0);
    expect(readdirSync(b)).toEqual(["sess_keep.jsonl"]);
  });

  it("prunes an ORPHAN trace with no session row — the common case, not an anomaly", () => {
    // THE-572 writes the trace file BEFORE the workspace_sessions row, so a failed start_session
    // leaves a file nothing references. Age is the only rule that can reach it; a reachability
    // join against the table would leave these behind forever.
    const dir = makeDir({ "sess_orphaned_by_failed_start.jsonl": 60 });
    expect(sweepTraceFiles([{ vaultId: "v1", dir }], { now: NOW, tracesDays: 30 })).toBe(1);
    expect(readdirSync(dir)).toHaveLength(0);
  });
});

// THE-610 containment. `resolveTraceDirs` computes a directory the sweep DELETES from, while
// `traceFolder` is only `z.string().min(1)` in the schema. An adversarial review of the first cut
// of this feature found it used a bare `path.join`, which is not a containment check —
// join("/v", "../../tmp/evil") === "/tmp/evil". These tests pin the fix.
describe("resolveTraceDirs containment (THE-610)", () => {
  const root = mkdtempSync(join(tmpdir(), "tc-vault-"));

  it("resolves a normal folder under the vault", () => {
    const [d] = resolveTraceDirs([{ id: "v1", path: root }], ".obsidian-tc/traces");
    expect(d?.dir).toBe(join(root, ".obsidian-tc/traces"));
  });

  it("REFUSES a traceFolder that escapes the vault", () => {
    expect(() =>
      resolveTraceDirs(
        [{ id: "v1", path: root, workspace: { traceFolder: "../../../../tmp/evil" } }],
        ".obsidian-tc/traces",
      ),
    ).toThrow();
  });

  it("REFUSES an absolute traceFolder", () => {
    expect(() =>
      resolveTraceDirs([{ id: "v1", path: root, workspace: { traceFolder: "/etc" } }], "x"),
    ).toThrow();
  });

  it("normalizes separators the same way traceRelPath does, so write and sweep agree", () => {
    // On POSIX `path.join` treats a backslash as a literal character. Without normalization the
    // write path stores under `a/b` while the sweep looks for the literal `a\b` — a directory that
    // never exists, so the sweep reports 0 forever while traces pile up.
    const [d] = resolveTraceDirs(
      [{ id: "v1", path: root, workspace: { traceFolder: "notes\\traces/" } }],
      "x",
    );
    expect(d?.dir).toBe(join(root, "notes/traces"));
    // and the write path derives its file from the SAME normalization
    expect(traceRelPath("notes\\traces/", "sess_1")).toBe("notes/traces/sess_1.jsonl");
  });

  it("write path and sweep path agree end to end", () => {
    const folder = "wk/traces";
    const [d] = resolveTraceDirs(
      [{ id: "v1", path: root, workspace: { traceFolder: folder } }],
      "x",
    );
    const abs = join(root, traceRelPath(folder, "sess_roundtrip"));
    appendTrace(abs, { ts: NOW - 90 * DAY });
    utimesSync(abs, (NOW - 90 * DAY) / 1000, (NOW - 90 * DAY) / 1000);
    // the sweep, given only the resolved dir, finds and prunes the file the writer created
    expect(
      sweepTraceFiles([{ vaultId: "v1", dir: d?.dir as string }], { now: NOW, tracesDays: 30 }),
    ).toBe(1);
  });
});
