// find_or_create_periodic_note and append_to_periodic_note CREATE a note after a noteExists() check.
// Both wrote non-exclusively, so a note created by someone else between the check and the commit was
// replaced by the template (find_or_create) or by the appended text alone (append). The create is
// now exclusive; a lost race returns the winner's note (find_or_create) or appends to it (append).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeM3Vault } from "./m3-helpers";

// While `lie.on`, the existence check claims every periodic note is absent — exactly what a
// concurrent creator landing between the check and the write looks like.
const lie = { on: false };
vi.mock("../src/vault/notes-io", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault/notes-io")>();
  return {
    ...actual,
    noteExists: (abs: string) => (lie.on ? { exists: false } : actual.noteExists(abs)),
  };
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  lie.on = false;
  for (const c of cleanups.splice(0)) c();
});

async function seededPath(v: ReturnType<typeof makeM3Vault>): Promise<string> {
  const r = await v.call("find_or_create_periodic_note", {
    vault: "test",
    period: "daily",
    date: "2026-01-15",
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return (r.data as { path: string }).path;
}

describe("periodic create is exclusive", () => {
  it("find_or_create_periodic_note returns the racer's note instead of clobbering it", async () => {
    const v = makeM3Vault();
    cleanups.push(v.cleanup);
    const path = await seededPath(v);
    writeFileSync(join(v.root, path), "WINNER CONTENT");
    lie.on = true;
    const r = await v.call("find_or_create_periodic_note", {
      vault: "test",
      period: "daily",
      date: "2026-01-15",
      include_content: true,
    });
    lie.on = false;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    // RED before the fix: the empty create replaced the file with "".
    expect(readFileSync(join(v.root, path), "utf8")).toBe("WINNER CONTENT");
    if (r.ok) {
      expect((r.data as { created: boolean }).created).toBe(false);
      expect((r.data as { content: string }).content).toBe("WINNER CONTENT");
    }
  });

  it("append_to_periodic_note appends to the racer's note instead of replacing it", async () => {
    const v = makeM3Vault();
    cleanups.push(v.cleanup);
    const path = await seededPath(v);
    writeFileSync(join(v.root, path), "WINNER CONTENT\n");
    lie.on = true;
    const r = await v.call("append_to_periodic_note", {
      vault: "test",
      period: "daily",
      date: "2026-01-15",
      content: "mine",
    });
    lie.on = false;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const after = readFileSync(join(v.root, path), "utf8");
    // RED before the fix: only "mine" survived.
    expect(after).toContain("WINNER CONTENT");
    expect(after).toContain("mine");
    if (r.ok) expect((r.data as { created: boolean }).created).toBe(false);
  });

  it("both still create a missing note", async () => {
    const v = makeM3Vault();
    cleanups.push(v.cleanup);
    const a = await v.call("append_to_periodic_note", {
      vault: "test",
      period: "daily",
      date: "2026-02-01",
      content: "first",
    });
    expect(a.ok && (a.data as { created: boolean }).created).toBe(true);
    const f = await v.call("find_or_create_periodic_note", {
      vault: "test",
      period: "daily",
      date: "2026-02-02",
    });
    expect(f.ok && (f.data as { created: boolean }).created).toBe(true);
  });
});
