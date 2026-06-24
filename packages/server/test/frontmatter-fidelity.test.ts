import { describe, expect, it } from "vitest";
import { parseNote, serializeNote } from "../src/vault/frontmatter";

function rt(raw: string, mutate: (fm: Record<string, unknown>) => void, newBody?: string): string {
  const p = parseNote(raw);
  const fm = { ...(p.frontmatter ?? {}) };
  mutate(fm);
  return serializeNote(fm, newBody ?? p.body, p.rawFrontmatter);
}

describe("frontmatter scalar fidelity (audit: no coercion of untouched keys)", () => {
  it("preserves leading/trailing-zero scalars when another key changes", () => {
    const out = rt("---\nzip: 01234\nversion: 1.10\nid: 007\nstatus: draft\n---\nbody\n", (fm) => {
      fm.status = "published";
    });
    expect(out).toContain("zip: 01234");
    expect(out).toContain("version: 1.10");
    expect(out).toContain("id: 007");
    expect(out).toContain("status: published");
  });

  it("preserves ALL frontmatter on a body-only edit (patch_note case)", () => {
    const out = rt("---\nzip: 01234\nv: 1.0\n---\nold\n", () => {}, "new body\n");
    expect(out).toBe("---\nzip: 01234\nv: 1.0\n---\nnew body\n");
  });

  it("re-emits a changed key, drops a deleted key, keeps untouched bytes", () => {
    const out = rt("---\nzip: 01234\ndrop: me\ncount: 5\n---\nb", (fm) => {
      fm.count = 6;
      delete fm.drop;
    });
    expect(out).toContain("zip: 01234");
    expect(out).toContain("count: 6");
    expect(out).not.toMatch(/^drop:/m);
  });

  it("appends a new key without disturbing existing scalars", () => {
    const out = rt("---\nzip: 01234\n---\nb", (fm) => {
      fm.added = true;
    });
    expect(out).toContain("zip: 01234");
    expect(out).toContain("added: true");
  });

  it("preserves a multi-line list value when a sibling changes", () => {
    const out = rt("---\ntags:\n  - a\n  - b\nzip: 01234\n---\nb", (fm) => {
      fm.zip = 99;
    });
    expect(out).toContain("tags:\n  - a\n  - b");
    expect(out).toContain("zip: 99");
  });

  it("falls back to a plain stringify for a new note (no original)", () => {
    expect(serializeNote({ a: 1, b: "x" }, "body")).toBe("---\na: 1\nb: x\n---\nbody");
  });
});
