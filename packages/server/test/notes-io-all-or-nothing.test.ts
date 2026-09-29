// Residual fix — `writeNotesAllOrNothingGuarded` (vault/notes-io.ts) is the shared two-pass
// (scan-everything, THEN write-everything) helper backing formats/attachments.ts's
// `rewriteAttachmentReferences`, move_note's backlink rewrite, and bulk_move_notes'
// `rewriteForMoves`. Deterministic, order-controlled unit tests against the helper itself — the
// property under test ("entry N throwing must leave entries BEFORE it unwritten") depends on
// processing order, and array order here is a guarantee `Array.prototype.map` gives; a real
// vault's `readdirSync` enumeration order is not, so this is the one place that can pin the bug
// without depending on filesystem traversal order.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeNotesAllOrNothingGuarded } from "../src/vault/notes-io";
import { rmTemp } from "./tmp";

function fakeOpenAiKey(): string {
  return ["sk", "-", "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "otc-notes-io-aon-"));
});

afterEach(() => {
  rmTemp(dir);
});

describe("writeNotesAllOrNothingGuarded — block mode is all-or-nothing across the whole batch", () => {
  it("a block-worthy entry LATER in the array refuses BEFORE an earlier, clean entry is written", () => {
    const cleanAbs = join(dir, "clean.md");
    const secretAbs = join(dir, "secret.md");
    writeFileSync(cleanAbs, "original clean body\n", "utf8");
    writeFileSync(secretAbs, "original secret-host body\n", "utf8");
    const secret = fakeOpenAiKey();

    let threw = false;
    try {
      // Array order IS processing order (Array.prototype.map) — "clean" is entry 0, "secret" is
      // entry 1. Pre-fix (per-entry scan-then-write inside one loop), entry 0 would already be on
      // disk by the time entry 1 throws.
      writeNotesAllOrNothingGuarded(
        [
          { abs: cleanAbs, path: "clean.md", content: "rewritten clean body\n" },
          { abs: secretAbs, path: "secret.md", content: `rewritten body with ${secret}\n` },
        ],
        { mode: "block", pii: false },
      );
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(ObsidianTcError);
      if (e instanceof ObsidianTcError) expect(e.code).toBe("secret_detected");
    }
    expect(threw, "expected a secret_detected refusal").toBe(true);

    // Neither file was written — not the refused one, and not the one that scanned clean BEFORE
    // it in the batch.
    expect(readFileSync(cleanAbs, "utf8")).toBe("original clean body\n");
    expect(readFileSync(secretAbs, "utf8")).toBe("original secret-host body\n");
  });

  it("no refusal anywhere in the batch: every entry's scanned content is persisted", () => {
    const aAbs = join(dir, "a.md");
    const bAbs = join(dir, "b.md");
    writeFileSync(aAbs, "old a\n", "utf8");
    writeFileSync(bAbs, "old b\n", "utf8");

    const out = writeNotesAllOrNothingGuarded(
      [
        { abs: aAbs, path: "a.md", content: "new a\n" },
        { abs: bAbs, path: "b.md", content: "new b\n" },
      ],
      { mode: "block", pii: false },
    );

    expect(readFileSync(aAbs, "utf8")).toBe("new a\n");
    expect(readFileSync(bAbs, "utf8")).toBe("new b\n");
    expect(out).toStrictEqual([
      { path: "a.md", content: "new a\n", redactions: 0 },
      { path: "b.md", content: "new b\n", redactions: 0 },
    ]);
  });

  it("redact mode: every persisted entry is the redacted form, and redactions are reported per entry", () => {
    const aAbs = join(dir, "a.md");
    const bAbs = join(dir, "b.md");
    writeFileSync(aAbs, "old a\n", "utf8");
    writeFileSync(bAbs, "old b\n", "utf8");
    const secret = fakeOpenAiKey();

    const out = writeNotesAllOrNothingGuarded(
      [
        { abs: aAbs, path: "a.md", content: "clean a\n" },
        { abs: bAbs, path: "b.md", content: `secret-bearing ${secret} b\n` },
      ],
      { mode: "redact", pii: false },
    );

    expect(readFileSync(aAbs, "utf8")).toBe("clean a\n");
    expect(readFileSync(bAbs, "utf8")).not.toContain(secret);
    expect(readFileSync(bAbs, "utf8")).toContain("[REDACTED]");
    expect(out[0]?.redactions).toBe(0);
    expect(out[1]?.redactions).toBeGreaterThan(0);
  });

  it("empty batch: no-op, no throw", () => {
    expect(writeNotesAllOrNothingGuarded([], { mode: "block", pii: false })).toStrictEqual([]);
  });
});
