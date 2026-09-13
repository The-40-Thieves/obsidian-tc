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

// THE-1040 (GH #932 review origin): a frontmatter block containing only YAML comments parses to
// an empty mapping ({}), indistinguishable from a genuinely blank block once parsed — only the
// RAW source text tells them apart, so the fix reads originalFrontmatter rather than the parsed
// object.
describe("frontmatter comment-only block survival (THE-1040)", () => {
  it("round-trips a comment-only block byte-identical on LF", () => {
    const raw = "---\n# preserve me\n---\n## A\nold\n";
    const p = parseNote(raw);
    expect(p.frontmatter).toEqual({});
    expect(serializeNote(p.frontmatter, p.body, p.rawFrontmatter)).toBe(raw);
  });

  it("round-trips a comment-only block byte-identical on CRLF", () => {
    const raw = "---\r\n# preserve me\r\n---\r\n## A\r\nold\r\n";
    const p = parseNote(raw);
    expect(p.frontmatter).toEqual({});
    expect(serializeNote(p.frontmatter, p.body, p.rawFrontmatter)).toBe(raw);
  });

  it("still drops a genuinely whitespace-only block", () => {
    const raw = "---\n\n---\nbody\n";
    const p = parseNote(raw);
    expect(p.frontmatter).toEqual({});
    expect(serializeNote(p.frontmatter, p.body, p.rawFrontmatter)).toBe("body\n");
  });

  it("keeps CRLF delimiters when a CRLF note's real keys are re-emitted", () => {
    const raw = "---\r\ntitle: Test\r\n---\r\nbody\r\n";
    const p = parseNote(raw);
    const fm = { ...(p.frontmatter ?? {}), title: "Changed" };
    const out = serializeNote(fm, p.body, p.rawFrontmatter);
    expect(out).toBe("---\r\ntitle: Changed\r\n---\r\nbody\r\n");
  });

  it("keeps LF delimiters for an untouched non-empty LF note (no regression)", () => {
    const raw = "---\nzip: 01234\nv: 1.0\n---\nold\n";
    const p = parseNote(raw);
    const out = serializeNote(p.frontmatter, "new body\n", p.rawFrontmatter);
    expect(out).toBe("---\nzip: 01234\nv: 1.0\n---\nnew body\n");
  });
});

// Fix round 1: C1 (delimiter EOL is captured at parse time, not inferred from content), C2 (a
// comment-only block is emitted byte-for-byte, trim() only decides keep-vs-drop), C3 (untouched
// keys re-joined with the block's own EOL, not a hardcoded "\n").
describe("THE-1040 fix round 1: C1-C3", () => {
  it("parseNote captures the opening delimiter's own EOL, independent of content", () => {
    expect(parseNote("---\ntitle: Test\n---\nbody\n").frontmatterEol).toBe("\n");
    expect(parseNote("---\r\ntitle: Test\r\n---\r\nbody\r\n").frontmatterEol).toBe("\r\n");
    // single-line block, no CRLF anywhere else in the note to infer from
    expect(parseNote("---\r\ntitle: Test\r\n---\r\nold").frontmatterEol).toBe("\r\n");
    expect(parseNote("no frontmatter here").frontmatterEol).toBeNull();
  });

  it("C1: options.frontmatterEol wins over a CRLF body when the block itself was LF", () => {
    const raw = "---\ntitle: Test\nzip: 01234\n---\n## A\r\nold\r\n";
    const p = parseNote(raw);
    const fm = { ...(p.frontmatter ?? {}), zip: 99999 };
    const out = serializeNote(fm, p.body, p.rawFrontmatter, { frontmatterEol: p.frontmatterEol });
    expect(out.startsWith("---\ntitle: Test\nzip: 99999\n---\n")).toBe(true);
  });

  it("C1: options.frontmatterEol recovers CRLF for a single-line block with no other \\r\\n signal", () => {
    const raw = "---\r\ntitle: Test\r\n---\r\nold";
    const p = parseNote(raw);
    const fm = { ...(p.frontmatter ?? {}), title: "Changed" };
    const out = serializeNote(fm, p.body, p.rawFrontmatter, { frontmatterEol: p.frontmatterEol });
    expect(out).toBe("---\r\ntitle: Changed\r\n---\r\nold");
  });

  it("C2: a comment-only block with interior blank lines round-trips byte-identical", () => {
    const raw = "---\n# preserve me\n\n\n---\nbody\n";
    const p = parseNote(raw);
    const out = serializeNote(p.frontmatter, p.body, p.rawFrontmatter, {
      frontmatterEol: p.frontmatterEol,
    });
    expect(out).toBe(raw);
  });

  it("C3: a CRLF block's untouched keys stay joined by CRLF when a sibling key changes", () => {
    const raw = "---\r\na: 1\r\nb: 2\r\nc: 3\r\n---\r\nbody\r\n";
    const p = parseNote(raw);
    const fm = { ...(p.frontmatter ?? {}), b: 22 };
    const out = serializeNote(fm, p.body, p.rawFrontmatter, { frontmatterEol: p.frontmatterEol });
    expect(out).toBe("---\r\na: 1\r\nb: 22\r\nc: 3\r\n---\r\nbody\r\n");
  });
});
