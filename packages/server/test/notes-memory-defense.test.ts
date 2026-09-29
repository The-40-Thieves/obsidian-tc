// GH #994 follow-up — memoryDefense on the GENERIC note-mutation tools: write_note, append_note,
// patch_note (including its replace_text operation). Before this file's fix, these three tools
// called writeNoteAtomic directly with no memoryDefense scan at all — a vault with
// `memoryDefense: { mode: "block" }` still let a caller write a secret straight into a note via
// write_note/append_note/patch_note, even into the vault's own configured memory folder. See
// experiential/memory-defense.ts's enforceMemoryDefenseOnNoteWrite for the guard these tests pin.
//
// Every secret used below is assembled at RUNTIME (string concatenation), never a single literal
// in source that itself matches a SECRET_PATTERNS regex — same no-literal-secret convention as
// test/memory-defense.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import { MetricsRecorder } from "../src/metrics/registry";
import { makeTestVault, type TestVault } from "./m1-helpers";

function fakeOpenAiKey(): string {
  return ["sk", "-", "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
}

function fakeGithubToken(): string {
  return ["gh", "p_", "M1n2B3v4C5x6Z7a8S9d0F1g2H3j4K5l6"].join("");
}

// Split so neither half alone matches openai_key's `\bsk-[A-Za-z0-9_-]{20,}\b` — only the
// ASSEMBLED (post-write) note body does. Proves patch_note's replace_text scans the RESULTING
// text, not just old_string/new_string individually.
function fakeOpenAiKeyHalves(): [string, string] {
  return ["sk-Q7w8E9r0T1y2U3i4O5p6A", "7s8D9f0G1h2"];
}

function un<T>(r: any): T {
  return r.data as T;
}
function errOf(r: any): { code: string; message: string; details?: Record<string, unknown> } {
  return r.error;
}

describe("memoryDefense on write_note/append_note/patch_note (GH #994 follow-up)", () => {
  let v: TestVault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  it("block mode: write_note refuses a secret-shaped body and never echoes the value", async () => {
    v = makeTestVault({ memoryDefense: { mode: "block", pii: false } });
    const secret = fakeOpenAiKey();
    const r = await v.call("write_note", { vault: "test", path: "leak.md", content: secret });
    expect(r.ok).toBe(false);
    const err = errOf(r);
    expect(err.code).toBe("secret_detected");
    expect(JSON.stringify(err)).not.toContain(secret);
    expect(v.exists("leak.md")).toBe(false);
  });

  it("redact mode: write_note persists [REDACTED] and reports redactions", async () => {
    v = makeTestVault({ memoryDefense: { mode: "redact", pii: false } });
    const secret = fakeGithubToken();
    const r = await v.call("write_note", { vault: "test", path: "ok.md", content: secret });
    expect(r.ok).toBe(true);
    expect(un<{ redactions: number }>(r).redactions).toBe(1);
    const body = v.read("ok.md");
    expect(body).not.toContain(secret);
    expect(body).toContain("[REDACTED]");
  });

  it("off (default): write_note persists a secret verbatim — unchanged baseline behaviour", async () => {
    v = makeTestVault();
    const secret = fakeOpenAiKey();
    const r = await v.call("write_note", { vault: "test", path: "plain.md", content: secret });
    expect(r.ok).toBe(true);
    expect(v.read("plain.md")).toBe(secret);
  });

  // Security review round (MEDIUM #4): `path` used to be scanned only as part of a DISCARDED
  // field inside enforceMemoryDefenseOnNoteWrite's own `enforceMemoryDefense` call — a secret-
  // shaped `path` was never actually refused in `redact` mode (there is no safe redacted form for
  // a filesystem path, same rule move_note/copy_note's destination already enforces). This is the
  // RED case that gap would have missed: a clean body, secret only in the PATH.
  it("redact mode: write_note refuses a secret-shaped path even with a completely clean body, nothing written at that path", async () => {
    v = makeTestVault({ memoryDefense: { mode: "redact", pii: false } });
    const secret = fakeOpenAiKey();
    const r = await v.call("write_note", {
      vault: "test",
      path: `${secret}.md`,
      content: "nothing secret in here",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errOf(r).code).toBe("secret_detected");
    expect(v.exists(`${secret}.md`)).toBe(false);
  });

  it("block mode: append_note refuses when the APPENDED text alone is secret-shaped", async () => {
    v = makeTestVault({
      memoryDefense: { mode: "block", pii: false },
      files: { "note.md": "clean prefix\n" },
    });
    const secret = fakeGithubToken();
    const r = await v.call("append_note", { vault: "test", path: "note.md", content: secret });
    expect(r.ok).toBe(false);
    expect(errOf(r).code).toBe("secret_detected");
    // Refused before any durable effect — the file's prior content is untouched.
    expect(v.read("note.md")).toBe("clean prefix\n");
  });

  it("redact mode: append_note redacts only the newly appended text, not the existing body", async () => {
    v = makeTestVault({
      memoryDefense: { mode: "redact", pii: false },
      files: { "note.md": "clean prefix\n" },
    });
    const secret = fakeOpenAiKey();
    const r = await v.call("append_note", { vault: "test", path: "note.md", content: secret });
    expect(r.ok).toBe(true);
    const body = v.read("note.md");
    expect(body).toContain("clean prefix");
    expect(body).not.toContain(secret);
    expect(body).toContain("[REDACTED]");
  });

  it("block mode: patch_note replace refuses when the patched RESULT is secret-shaped", async () => {
    v = makeTestVault({
      memoryDefense: { mode: "block", pii: false },
      files: { "note.md": "# Heading\n\nold body\n" },
    });
    const secret = fakeGithubToken();
    const r = await v.call("patch_note", {
      vault: "test",
      path: "note.md",
      operation: "replace",
      anchor: { type: "heading", heading: "Heading" },
      content: secret,
    });
    expect(r.ok).toBe(false);
    expect(errOf(r).code).toBe("secret_detected");
    expect(v.read("note.md")).toBe("# Heading\n\nold body\n");
  });

  it("block mode: patch_note replace_text refuses when old+new ASSEMBLE a secret neither half alone matches", async () => {
    const [left, right] = fakeOpenAiKeyHalves();
    v = makeTestVault({
      memoryDefense: { mode: "block", pii: false },
      files: { "note.md": `# Heading\n\n${left}PLACEHOLDER\n` },
    });
    const r = await v.call("patch_note", {
      vault: "test",
      path: "note.md",
      operation: "replace_text",
      anchor: { type: "heading", heading: "Heading" },
      old_string: "PLACEHOLDER",
      new_string: right,
    });
    expect(r.ok).toBe(false);
    expect(errOf(r).code).toBe("secret_detected");
    // The pre-patch file is untouched — refused before the write.
    expect(v.read("note.md")).toBe(`# Heading\n\n${left}PLACEHOLDER\n`);
  });

  it("redact mode: patch_note replace_text redacts the assembled result and reports redactions", async () => {
    const [left, right] = fakeOpenAiKeyHalves();
    v = makeTestVault({
      memoryDefense: { mode: "redact", pii: false },
      files: { "note.md": `# Heading\n\n${left}PLACEHOLDER\n` },
    });
    const r = await v.call("patch_note", {
      vault: "test",
      path: "note.md",
      operation: "replace_text",
      anchor: { type: "heading", heading: "Heading" },
      old_string: "PLACEHOLDER",
      new_string: right,
    });
    expect(r.ok).toBe(true);
    expect(un<{ redactions: number }>(r).redactions).toBe(1);
    const body = v.read("note.md");
    expect(body).not.toContain(left + right);
    expect(body).toContain("[REDACTED]");
  });

  it("block mode applies vault-wide, not only inside the configured memory folder", async () => {
    v = makeTestVault({ memoryDefense: { mode: "block", pii: false } });
    const secret = fakeOpenAiKey();
    // "journal/" is nowhere near the default "memory" folder — the guard still fires.
    const r = await v.call("write_note", {
      vault: "test",
      path: "journal/2026-09-28.md",
      content: secret,
    });
    expect(r.ok).toBe(false);
    expect(errOf(r).code).toBe("secret_detected");
  });

  it("a matched hit is tagged on the memoryDefense metric, never as a content-bearing label", async () => {
    const metrics = new MetricsRecorder();
    v = makeTestVault({ memoryDefense: { mode: "redact", pii: false }, metrics });
    const secret = fakeOpenAiKey();
    await v.call("write_note", { vault: "test", path: "m.md", content: secret });
    const dump = await metrics.metrics();
    expect(dump).toContain('obsidian_tc_memory_defense_hits_total{pattern="openai_key"} 1');
    expect(dump).not.toContain(secret);
  });
});
