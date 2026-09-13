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

// Fix round 2, from the task re-review's O1 and Codex's X1-X3: survivingComments stripped a
// removed key's own NODE range, not its full source LINE(S) — leaving an inline trailing
// comment and (via the CRLF join added for X2) a residual line-break behind as orphaned
// fragments. Line-based removal fixes both by construction.
describe("THE-1040 fix round 2: O1 (line-based key removal) and X1-X3", () => {
  function removeKeys(raw: string, ...keys: string[]) {
    const p = parseNote(raw);
    const fm = { ...(p.frontmatter ?? {}) };
    for (const k of keys) delete fm[k];
    const hasKeys = Object.keys(fm).length > 0;
    return serializeNote(hasKeys ? fm : null, p.body, p.rawFrontmatter, {
      frontmatterEol: p.frontmatterEol,
    });
  }

  it("O1: an inline trailing comment on the removed key's own line goes with it", () => {
    const raw = "---\n# keep me\ntags: [x] # note\n---\nbody\n";
    expect(removeKeys(raw, "tags")).toBe("---\n# keep me\n---\nbody\n");
  });

  it("O1: a removed key's multi-line list value (with a trailing comment on the key line) is fully stripped", () => {
    const raw = "---\n# keep me\ntags: # note\n  - a\n  - b\n---\nbody\n";
    expect(removeKeys(raw, "tags")).toBe("---\n# keep me\n---\nbody\n");
  });

  it("O1: a full-line comment between two removed keys survives, unattached to either", () => {
    const raw = "---\na: 1\n# between\nb: 2\n---\nbody\n";
    expect(removeKeys(raw, "a", "b")).toBe("---\n# between\n---\nbody\n");
  });

  it("O1: a removed key followed by a blank line and a comment keeps both", () => {
    const raw = "---\nonly: 1\n\n# note\n---\nbody\n";
    expect(removeKeys(raw, "only")).toBe("---\n\n# note\n---\nbody\n");
  });

  it("X1: removing a neighbor key leaves a CRLF multi-line list value intact (no doubled \\r)", () => {
    const raw = "---\r\nlist:\r\n  - x\r\n  - y\r\ngone: 1\r\ntail: ok\r\n---\r\nbody\r\n";
    const p = parseNote(raw);
    const fm = { ...(p.frontmatter ?? {}) };
    delete fm.gone;
    const out = serializeNote(fm, p.body, p.rawFrontmatter, { frontmatterEol: p.frontmatterEol });
    expect(out).toBe("---\r\nlist:\r\n  - x\r\n  - y\r\ntail: ok\r\n---\r\nbody\r\n");
  });

  it("X2: surviving comment lines join with the block's own CRLF, not a hardcoded LF", () => {
    const raw = "---\r\n# leading\r\ngone: 1\r\n# trailing\r\n---\r\n";
    expect(removeKeys(raw, "gone")).toBe("---\r\n# leading\r\n# trailing\r\n---\r\n");
  });

  it("X3: a no-op merge changes no bytes, trailing blank lines included", () => {
    const raw = "---\na: 1\n\n\n---\nbody\n";
    const p = parseNote(raw);
    const fm = { ...(p.frontmatter ?? {}) }; // merge with {} — unchanged
    const out = serializeNote(fm, p.body, p.rawFrontmatter, { frontmatterEol: p.frontmatterEol });
    expect(out).toBe(raw);
  });
});

// Fix round 3, from the round-2 re-review: S1 — emitFrontmatter spliced an UNCHANGED key back
// from its own AST node range, dropping an inline trailing comment on that key's line whenever
// a SIBLING key changed. Same class as O1 (an inline comment belongs to its key), applied to
// the preserve path instead of the remove path — and reusing O1's line-boundary machinery
// exposed a real bug in it (a multi-line node's own range often already ends at the START of
// the next line, so searching forward for "the next \n" walked into that next line's own
// terminator and swallowed an unrelated neighbor — the line-list model THE-1043 replaced that
// machinery with keeps the same guard, so these stay as regression tests).
describe("THE-1040 fix round 3: S1 (unchanged key's inline comment survives a sibling's change)", () => {
  it("S1: an unchanged key's inline trailing comment survives when a sibling key changes (LF)", () => {
    const raw = "---\na: 1\nb: 2 # keep this comment\n---\nbody\n";
    const p = parseNote(raw);
    const fm = { ...(p.frontmatter ?? {}), a: 9 };
    const out = serializeNote(fm, p.body, p.rawFrontmatter, { frontmatterEol: p.frontmatterEol });
    expect(out).toBe("---\na: 9\nb: 2 # keep this comment\n---\nbody\n");
  });

  it("S1: same, CRLF", () => {
    const raw = "---\r\na: 1\r\nb: 2 # keep this comment\r\n---\r\nbody\r\n";
    const p = parseNote(raw);
    const fm = { ...(p.frontmatter ?? {}), a: 9 };
    const out = serializeNote(fm, p.body, p.rawFrontmatter, { frontmatterEol: p.frontmatterEol });
    expect(out).toBe("---\r\na: 9\r\nb: 2 # keep this comment\r\n---\r\nbody\r\n");
  });

  it("S1: an unchanged multi-line value with a trailing comment on its key line survives a sibling's change", () => {
    const raw = "---\na: 1\ntags: # keep\n  - x\n  - y\n---\nbody\n";
    const p = parseNote(raw);
    const fm = { ...(p.frontmatter ?? {}), a: 9 };
    const out = serializeNote(fm, p.body, p.rawFrontmatter, { frontmatterEol: p.frontmatterEol });
    expect(out).toBe("---\na: 9\ntags: # keep\n  - x\n  - y\n---\nbody\n");
  });

  // Regression guard for the bug S1's own fix uncovered: an unchanged multi-line list's own
  // AST range already ends at the START of the next key's line, so this proves that boundary is
  // not walked into and the following key survives too.
  it("S1: removing a neighbor key next to an unchanged multi-line list leaves both intact (CRLF)", () => {
    const raw = "---\r\nlist:\r\n  - x\r\n  - y\r\ngone: 1\r\ntail: ok\r\n---\r\nbody\r\n";
    const p = parseNote(raw);
    const fm = { ...(p.frontmatter ?? {}) };
    delete fm.gone;
    const out = serializeNote(fm, p.body, p.rawFrontmatter, { frontmatterEol: p.frontmatterEol });
    expect(out).toBe("---\r\nlist:\r\n  - x\r\n  - y\r\ntail: ok\r\n---\r\nbody\r\n");
  });
});

// Round-3 re-review addition: an unchanged block scalar (literal `|`, folded `>`, keep-chomp
// `|+`) must stay intact — its line span must not reach past its own trailing "\n" into the
// NEXT key's line — when a SIBLING key changes and only that sibling's own entry is re-emitted.
describe("THE-1040 fix round 3 review: an unchanged block scalar survives a sibling's change", () => {
  it("literal `|` block scalar is untouched when a sibling key changes", () => {
    const raw = "---\ntext: |\n  a\nnext: 1\n---\nbody\n";
    const p = parseNote(raw);
    const fm = { ...(p.frontmatter ?? {}), next: 9 };
    const out = serializeNote(fm, p.body, p.rawFrontmatter, { frontmatterEol: p.frontmatterEol });
    expect(out).toBe("---\ntext: |\n  a\nnext: 9\n---\nbody\n");
  });

  it("folded `>` block scalar is untouched when a sibling key changes", () => {
    const raw = "---\ntext: >\n  a\nnext: 1\n---\nbody\n";
    const p = parseNote(raw);
    const fm = { ...(p.frontmatter ?? {}), next: 9 };
    const out = serializeNote(fm, p.body, p.rawFrontmatter, { frontmatterEol: p.frontmatterEol });
    expect(out).toBe("---\ntext: >\n  a\nnext: 9\n---\nbody\n");
  });

  it("keep-chomp `|+` block scalar is untouched when a sibling key changes", () => {
    const raw = "---\ntext: |+\n  a\nnext: 1\n---\nbody\n";
    const p = parseNote(raw);
    const fm = { ...(p.frontmatter ?? {}), next: 9 };
    const out = serializeNote(fm, p.body, p.rawFrontmatter, { frontmatterEol: p.frontmatterEol });
    expect(out).toBe("---\ntext: |+\n  a\nnext: 9\n---\nbody\n");
  });
});

// THE-1043, from the post-merge Codex pass on THE-1040: the emitter now works on the original
// block's LINE LIST. A key owns the lines its node covers only when the node starts at a line
// start and ends at a line end (block style); a key sharing a line with siblings (a root flow
// mapping) has its whole line re-emitted from the changed mapping instead. Every line owned by
// no changed/removed key survives verbatim, and a removed key's lines are spliced out leaving
// exactly one line break — the block's own EOL — between the neighbours.
describe("THE-1043: the emitter works on the original block's lines", () => {
  function removeKeys(raw: string, ...keys: string[]) {
    const p = parseNote(raw);
    const fm = { ...(p.frontmatter ?? {}) };
    for (const k of keys) delete fm[k];
    const hasKeys = Object.keys(fm).length > 0;
    return serializeNote(hasKeys ? fm : null, p.body, p.rawFrontmatter, {
      frontmatterEol: p.frontmatterEol,
      frontmatterAtEof: p.frontmatterAtEof,
    });
  }
  function setKey(raw: string, key: string, value: unknown) {
    const p = parseNote(raw);
    const fm = { ...(p.frontmatter ?? {}), [key]: value };
    return serializeNote(fm, p.body, p.rawFrontmatter, {
      frontmatterEol: p.frontmatterEol,
      frontmatterAtEof: p.frontmatterAtEof,
    });
  }

  it("P1: removing one key of a root flow mapping re-emits the line without it", () => {
    expect(removeKeys("---\n{a: 1, b: 2}\n---\nbody\n", "a")).toBe("---\nb: 2\n---\nbody\n");
  });

  it("P1: changing one key of a root flow mapping re-emits the line, not a duplicate", () => {
    expect(setKey("---\n{a: 1, b: 2}\n---\nbody\n", "a", 9)).toBe("---\na: 9\nb: 2\n---\nbody\n");
  });

  it("P1: a root flow mapping spanning two lines is re-emitted as one group", () => {
    expect(removeKeys("---\n{a: 1,\n b: 2}\n---\nbody\n", "a")).toBe("---\nb: 2\n---\nbody\n");
  });

  // F1 (fix round 1): a MULTI-LINE flow root put its braces on lines of their own, which no key
  // owned — left verbatim around block-style re-emitted entries they produced invalid YAML
  // ("---\n{\na: 9\nb: 2\n}\n---"). The whole root collection, braces included, is one unit.
  it("F1: a multi-line root flow mapping is re-emitted whole when a key changes", () => {
    expect(setKey("---\n{\na: 1,\nb: 2\n}\n---\nbody\n", "a", 9)).toBe(
      "---\na: 9\nb: 2\n---\nbody\n",
    );
  });

  it("F1: a multi-line root flow mapping is re-emitted whole when a key is removed", () => {
    expect(removeKeys("---\n{\na: 1,\nb: 2\n}\n---\nbody\n", "a")).toBe("---\nb: 2\n---\nbody\n");
  });

  it("F1: comments outside the braces survive a flow mapping's rewrite", () => {
    expect(setKey("---\n# lead\n{a: 1, b: 2}\n# tail\n---\nbody\n", "a", 9)).toBe(
      "---\n# lead\na: 9\nb: 2\n# tail\n---\nbody\n",
    );
    expect(setKey("---\n# lead\n{\na: 1,\nb: 2\n}\n# tail\n---\nbody\n", "a", 9)).toBe(
      "---\n# lead\na: 9\nb: 2\n# tail\n---\nbody\n",
    );
  });

  // G1/H1/H2 (fix rounds 2-3): text on or inside a flow root's braces belongs to no key, and a
  // rebuild used to swallow it. It is preserved as FULL-LINE comments — what is inside or on the
  // opening brace before the rebuilt mapping, what follows the closing brace after it. Placement
  // is normalized, content is not: appending a tail to the last emitted line glued it into a
  // multi-line value (H1), and a whitespace-only tail padded that value with spaces.
  it("G1: a comment after a flow mapping's closing brace survives a key change", () => {
    expect(setKey("---\n# lead\n{\na: 1,\nb: 2\n} # closing\n# tail\n---\nbody\n", "a", 9)).toBe(
      "---\n# lead\na: 9\nb: 2\n# closing\n# tail\n---\nbody\n",
    );
  });

  it("G1: same, on a key removal", () => {
    expect(removeKeys("---\n# lead\n{\na: 1,\nb: 2\n} # closing\n# tail\n---\nbody\n", "a")).toBe(
      "---\n# lead\nb: 2\n# closing\n# tail\n---\nbody\n",
    );
  });

  it("G1: same, CRLF", () => {
    const raw = "---\r\n# lead\r\n{\r\na: 1,\r\nb: 2\r\n} # closing\r\n# tail\r\n---\r\nbody\r\n";
    expect(setKey(raw, "a", 9)).toBe(
      "---\r\n# lead\r\na: 9\r\nb: 2\r\n# closing\r\n# tail\r\n---\r\nbody\r\n",
    );
    expect(removeKeys(raw, "a")).toBe(
      "---\r\n# lead\r\nb: 2\r\n# closing\r\n# tail\r\n---\r\nbody\r\n",
    );
  });

  it("G1: same, for the single-line flow form", () => {
    expect(setKey("---\n{a: 1, b: 2} # note\n---\nbody\n", "a", 9)).toBe(
      "---\na: 9\nb: 2\n# note\n---\nbody\n",
    );
    expect(removeKeys("---\n{a: 1, b: 2} # note\n---\nbody\n", "a")).toBe(
      "---\nb: 2\n# note\n---\nbody\n",
    );
  });

  it("H1: the closing-brace comment never joins an emitted multi-line value", () => {
    const out = setKey("---\n{a: 1, b: 2} # close\n---", "b", "hello\nworld\n");
    expect(out).toBe("---\na: 1\nb: |\n  hello\n  world\n# close\n---");
    expect(parseNote(out).frontmatter?.b).toBe("hello\nworld\n");
  });

  it("H1: same, CRLF", () => {
    const out = setKey("---\r\n{a: 1, b: 2} # close\r\n---\r\n", "b", "hello\nworld\n");
    expect(out).toBe("---\r\na: 1\r\nb: |\r\n  hello\r\n  world\r\n# close\r\n---\r\n");
    expect(parseNote(out).frontmatter?.b).toBe("hello\nworld\n");
  });

  it("H1: a whitespace-only brace tail is dropped, not appended to the value", () => {
    const out = setKey("---\n{a: 1, b: 2}   \n---\nbody\n", "b", "hello\nworld\n");
    expect(out).toBe("---\na: 1\nb: |\n  hello\n  world\n---\nbody\n");
    expect(parseNote(out).frontmatter?.b).toBe("hello\nworld\n");
  });

  it("H2: a comment on the opening brace survives, before the rebuilt mapping", () => {
    expect(setKey("---\n{ # open\na: 1, b: 2\n} # close\n---", "a", 9)).toBe(
      "---\n# open\na: 9\nb: 2\n# close\n---",
    );
    expect(removeKeys("---\n{ # open\na: 1, b: 2\n} # close\n---", "a")).toBe(
      "---\n# open\nb: 2\n# close\n---",
    );
  });

  it("H2: a full-line comment between two flow entries survives", () => {
    expect(setKey("---\n{\na: 1,\n# mid\nb: 2\n}\n---\nbody\n", "a", 9)).toBe(
      "---\n# mid\na: 9\nb: 2\n---\nbody\n",
    );
  });

  // A flow line's unchanged key splices back by its own node range, so it must BE a mapping entry
  // on its own: `{a: , b: 2}`'s empty value still ranges as one, `{a, b: 2}`'s bare key does not
  // and re-serializes instead. Both must stay re-readable after a sibling changes.
  it("F1: an unchanged bare or empty-valued key on a flow line stays a valid entry", () => {
    expect(setKey("---\n{a: , b: 2}\n---\nbody\n", "b", 3)).toBe("---\na: \nb: 3\n---\nbody\n");
    expect(setKey("---\n{a, b: 2}\n---\nbody\n", "b", 3)).toBe("---\na: null\nb: 3\n---\nbody\n");
  });

  it("P2: removing the last key with a multi-line value keeps its neighbours on separate lines", () => {
    expect(removeKeys("---\n# lead\nlist:\n  - x\n  - y\n# tail\n---\n", "list")).toBe(
      "---\n# lead\n# tail\n---\n",
    );
  });

  it("P2: same, CRLF", () => {
    expect(
      removeKeys("---\r\n# lead\r\nlist:\r\n  - x\r\n  - y\r\n# tail\r\n---\r\n", "list"),
    ).toBe("---\r\n# lead\r\n# tail\r\n---\r\n");
  });

  it("P3: removing a CRLF block's last key leaves no stray \\r on the surviving line", () => {
    expect(removeKeys("---\r\n# lead\r\ntags: [x]\r\n---\r\n", "tags")).toBe(
      "---\r\n# lead\r\n---\r\n",
    );
  });

  it("P4: standalone comments and blank lines survive a key CHANGE", () => {
    expect(setKey("---\n# lead\na: 1\n\n# keep\nb: 2\n# tail\n---\n", "a", 9)).toBe(
      "---\n# lead\na: 9\n\n# keep\nb: 2\n# tail\n---\n",
    );
  });

  it("P4: same, CRLF", () => {
    expect(setKey("---\r\n# lead\r\na: 1\r\n\r\n# keep\r\nb: 2\r\n# tail\r\n---\r\n", "a", 9)).toBe(
      "---\r\n# lead\r\na: 9\r\n\r\n# keep\r\nb: 2\r\n# tail\r\n---\r\n",
    );
  });

  it("P4: a comment-only block keeps its comments when a key is ADDED", () => {
    expect(setKey("---\n# lead\n# tail\n---\nbody\n", "tags", ["x"])).toBe(
      "---\n# lead\n# tail\ntags:\n  - x\n---\nbody\n",
    );
  });

  it("P5: a closing delimiter at EOF stays at EOF on a no-op merge", () => {
    const raw = "---\na: 1\n---";
    const p = parseNote(raw);
    expect(
      serializeNote({ ...(p.frontmatter ?? {}) }, p.body, p.rawFrontmatter, {
        frontmatterEol: p.frontmatterEol,
        frontmatterAtEof: p.frontmatterAtEof,
      }),
    ).toBe(raw);
  });

  it("P5: a closing delimiter at EOF stays at EOF when a key changes", () => {
    expect(setKey("---\na: 1\n---", "a", 9)).toBe("---\na: 9\n---");
  });

  // Incidental to rebuilding the block line by line: a re-serialized multi-line value is now
  // joined with the block's own eol like every other line, not YAML.stringify's hardcoded LF.
  it("a new multi-line value on a CRLF block is emitted with CRLF", () => {
    expect(setKey("---\r\na: 1\r\n---\r\nbody\r\n", "tags", ["x", "y"])).toBe(
      "---\r\na: 1\r\ntags:\r\n  - x\r\n  - y\r\n---\r\nbody\r\n",
    );
  });

  it("P5: a note that DOES end with a newline after the delimiter keeps it", () => {
    expect(setKey("---\na: 1\n---\n", "a", 9)).toBe("---\na: 9\n---\n");
  });

  // Promoted from THE-1040's X4 `it.todo`: the line-list model makes it pass. A `|+`
  // (keep-chomp) block scalar's trailing blank lines sit outside the yaml library's own value
  // range, but they are still LINES no other key owns, so removing a neighbour leaves them be.
  // THE-1044 corrected the expectation: those lines survived, but the closing "---" then ate the
  // line break the LAST of them needs, so the byte output asserted here read back a newline short.
  it("X4 (promoted): removing a neighbour preserves a `|+` block scalar's trailing blank lines", () => {
    const raw = "---\ntext: |+\n  hello\n\n\ngone: 1\n---\n";
    const out = removeKeys(raw, "gone");
    expect(out).toBe("---\ntext: |+\n  hello\n\n\n\n---\n");
    expect(parseNote(out).frontmatter).toEqual({ text: parseNote(raw).frontmatter?.text });
  });
});

// THE-1044, promoted from the two `it.todo`s THE-1043 left behind (Codex pass origin). Both are
// about what a re-serialized VALUE loses, not about the line list: re-emitting an anchored key
// left a sibling's `*alias` pointing at an anchor that no longer existed, and an ASSIGNED string's
// trailing newlines — the value of a `|+` scalar, not a separator — were trimmed off. Every
// assertion below re-parses the output and checks the VALUE, so a byte expectation copied from a
// wrong output cannot pass on its own.
describe("THE-1044: aliases stay valid and an assigned scalar is never trimmed", () => {
  function setKey(raw: string, key: string, value: unknown) {
    const p = parseNote(raw);
    const fm = { ...(p.frontmatter ?? {}), [key]: value };
    return serializeNote(fm, p.body, p.rawFrontmatter, {
      frontmatterEol: p.frontmatterEol,
      frontmatterAtEof: p.frontmatterAtEof,
    });
  }
  function removeKeys(raw: string, ...keys: string[]) {
    const p = parseNote(raw);
    const fm = { ...(p.frontmatter ?? {}) };
    for (const k of keys) delete fm[k];
    return serializeNote(fm, p.body, p.rawFrontmatter, {
      frontmatterEol: p.frontmatterEol,
      frontmatterAtEof: p.frontmatterAtEof,
    });
  }
  const read = (out: string) => parseNote(out).frontmatter;

  const ALIASED = "---\na: &x [1, 2]\nb: *x\n---\nbody\n";

  it("A1 (promoted): changing an anchored key leaves no dangling alias", () => {
    const out = setKey(ALIASED, "a", 9);
    expect(out).not.toContain("*x");
    expect(out).toBe("---\na: 9\nb:\n  - 1\n  - 2\n---\nbody\n");
    expect(read(out)).toEqual({ a: 9, b: [1, 2] });
  });

  it("A1 (promoted): removing an anchored key materializes the alias as a copy", () => {
    const out = removeKeys(ALIASED, "a");
    expect(out).toBe("---\nb:\n  - 1\n  - 2\n---\nbody\n");
    expect(read(out)).toEqual({ b: [1, 2] });
  });

  it("A2: an alias to an anchor nested inside a changed value is materialized too", () => {
    const out = setKey("---\na:\n  - &x 1\n  - 2\nb: *x\n---\n", "a", [7]);
    expect(read(out)).toEqual({ a: [7], b: 1 });
    expect(out).not.toContain("*x");
  });

  it("A3: an alias whose anchor is untouched survives a change to another key", () => {
    const out = setKey("---\na: &x [1, 2]\nb: *x\nc: 3\n---\n", "c", 9);
    expect(out).toBe("---\na: &x [ 1, 2 ]\nb: *x\nc: 9\n---\n");
    expect(read(out)).toEqual({ a: [1, 2], b: [1, 2], c: 9 });
  });

  it("A4: comments survive an alias block edited in document mode", () => {
    const out = setKey("---\n# lead\na: &x [1, 2]\nb: *x # why\n# tail\nc: 3\n---\n", "a", 9);
    expect(out).toContain("# lead");
    expect(out).toContain("# why");
    expect(out).toContain("# tail");
    expect(read(out)).toEqual({ a: 9, b: [1, 2], c: 3 });
  });

  it("A5: an alias block on CRLF comes back on CRLF", () => {
    const out = setKey("---\r\na: &x [1, 2]\r\nb: *x\r\n---\r\n", "a", 9);
    expect(out).toBe("---\r\na: 9\r\nb:\r\n  - 1\r\n  - 2\r\n---\r\n");
    expect(read(out)).toEqual({ a: 9, b: [1, 2] });
  });

  it("K1 (promoted): an assigned keep-chomp string keeps all three trailing newlines", () => {
    const out = setKey("---\ntext: 1\n---\n", "text", "hello\n\n\n");
    expect(read(out)).toEqual({ text: "hello\n\n\n" });
    expect(out).toBe("---\ntext: |+\n  hello\n\n\n\n---\n");
  });

  it("K2: two trailing newlines round-trip", () => {
    const out = setKey("---\ntext: 1\n---\n", "text", "hello\n\n");
    expect(read(out)).toEqual({ text: "hello\n\n" });
  });

  it("K3: one trailing newline round-trips as a clip scalar", () => {
    const out = setKey("---\ntext: 1\n---\n", "text", "hello\n");
    expect(out).toBe("---\ntext: |\n  hello\n---\n");
    expect(read(out)).toEqual({ text: "hello\n" });
  });

  it("K4: a keep-chomp value followed by a sibling key round-trips", () => {
    const out = setKey("---\na: 1\nb: 2\n---\n", "a", "hello\n\n\n");
    expect(out).toBe("---\na: |+\n  hello\n\n\nb: 2\n---\n");
    expect(read(out)).toEqual({ a: "hello\n\n\n", b: 2 });
  });

  it("K5: a keep-chomp value round-trips on a CRLF block", () => {
    const out = setKey("---\r\na: 1\r\nb: 2\r\n---\r\n", "a", "hello\n\n\n");
    expect(out).toBe("---\r\na: |+\r\n  hello\r\n\r\n\r\nb: 2\r\n---\r\n");
    expect(read(out)).toEqual({ a: "hello\n\n\n", b: 2 });
  });

  it("K6: a strip-chomp value (no trailing newline) round-trips", () => {
    const out = setKey("---\ntext: 1\n---\n", "text", "hello\nworld");
    expect(out).toBe("---\ntext: |-\n  hello\n  world\n---\n");
    expect(read(out)).toEqual({ text: "hello\nworld" });
  });

  it("K7: a clip value (one trailing newline, several lines) round-trips", () => {
    const out = setKey("---\ntext: 1\n---\n", "text", "hello\nworld\n");
    expect(out).toBe("---\ntext: |\n  hello\n  world\n---\n");
    expect(read(out)).toEqual({ text: "hello\nworld\n" });
  });

  it("K8: a brand-new note (no original block) keeps a keep-chomp value too", () => {
    const out = serializeNote({ text: "hello\n\n\n" }, "body\n");
    expect(read(out)).toEqual({ text: "hello\n\n\n" });
  });
});

// THE-1044 round 2: the same class on the REMOVAL/SPLICE path. A block scalar's trailing newlines
// are content; the separator between the block's last line and the closing "---" is exactly one
// block EOL and is never taken from the value. `parseNote`'s capture stops one line break short of
// that delimiter, so a block ENDING in a keep-chomp scalar — emitted or spliced back verbatim —
// used to read one newline light the moment any neighbour moved.
describe("THE-1044 R: a keep-chomp value ending the block survives a neighbour's edit", () => {
  function setKey(raw: string, key: string, value: unknown) {
    const p = parseNote(raw);
    const fm = { ...(p.frontmatter ?? {}), [key]: value };
    return serializeNote(fm, p.body, p.rawFrontmatter, {
      frontmatterEol: p.frontmatterEol,
      frontmatterAtEof: p.frontmatterAtEof,
    });
  }
  function removeKeys(raw: string, ...keys: string[]) {
    const p = parseNote(raw);
    const fm = { ...(p.frontmatter ?? {}) };
    for (const k of keys) delete fm[k];
    const hasKeys = Object.keys(fm).length > 0;
    return serializeNote(hasKeys ? fm : null, p.body, p.rawFrontmatter, {
      frontmatterEol: p.frontmatterEol,
      frontmatterAtEof: p.frontmatterAtEof,
    });
  }
  const read = (out: string) => parseNote(out).frontmatter;

  it("R1: keep-chomp FIRST, the only other key removed (LF)", () => {
    const raw = "---\ntext: |+\n  hello\n\n\ngone: 1\n---\n";
    expect(read(raw)).toEqual({ text: "hello\n\n\n", gone: 1 });
    const out = removeKeys(raw, "gone");
    expect(read(out)).toEqual({ text: "hello\n\n\n" });
    expect(out).toBe("---\ntext: |+\n  hello\n\n\n\n---\n");
  });

  it("R2: keep-chomp FIRST, a middle key removed while another still follows", () => {
    const raw = "---\ntext: |+\n  hello\n\n\nmid: 1\nlast: 2\n---\n";
    expect(read(raw)).toEqual({ text: "hello\n\n\n", mid: 1, last: 2 });
    const out = removeKeys(raw, "mid");
    expect(read(out)).toEqual({ text: "hello\n\n\n", last: 2 });
    expect(out).toBe("---\ntext: |+\n  hello\n\n\nlast: 2\n---\n");
  });

  it("R3: keep-chomp MIDDLE, the key after it removed (LF)", () => {
    const raw = "---\nfirst: 1\ntext: |+\n  hello\n\n\nlast: 2\n---\n";
    expect(read(raw)).toEqual({ first: 1, text: "hello\n\n\n", last: 2 });
    const out = removeKeys(raw, "last");
    expect(read(out)).toEqual({ first: 1, text: "hello\n\n\n" });
    expect(out).toBe("---\nfirst: 1\ntext: |+\n  hello\n\n\n\n---\n");
  });

  it("R4: keep-chomp FIRST, the key after it CHANGED", () => {
    const raw = "---\ntext: |+\n  hello\n\n\ngone: 1\n---\n";
    const out = setKey(raw, "gone", 9);
    expect(read(out)).toEqual({ text: "hello\n\n\n", gone: 9 });
    expect(out).toBe("---\ntext: |+\n  hello\n\n\ngone: 9\n---\n");
  });

  it("R5: keep-chomp already LAST in the source, the key before it removed", () => {
    const raw = "---\ngone: 1\ntext: |+\n  hello\n\n\n\n---\n";
    expect(read(raw)).toEqual({ gone: 1, text: "hello\n\n\n" });
    const out = removeKeys(raw, "gone");
    expect(read(out)).toEqual({ text: "hello\n\n\n" });
    expect(out).toBe("---\ntext: |+\n  hello\n\n\n\n---\n");
  });

  it("R6: keep-chomp already LAST in the source, the key before it CHANGED", () => {
    const raw = "---\nfirst: 1\ntext: |+\n  hello\n\n\n\n---\n";
    expect(read(raw)).toEqual({ first: 1, text: "hello\n\n\n" });
    const out = setKey(raw, "first", 9);
    expect(read(out)).toEqual({ first: 9, text: "hello\n\n\n" });
    expect(out).toBe("---\nfirst: 9\ntext: |+\n  hello\n\n\n\n---\n");
  });

  it("R7: keep-chomp FIRST on CRLF, the key after it removed", () => {
    const raw = "---\r\ntext: |+\r\n  hello\r\n\r\n\r\ngone: 1\r\n---\r\n";
    expect(read(raw)).toEqual({ text: "hello\n\n\n", gone: 1 });
    const out = removeKeys(raw, "gone");
    expect(read(out)).toEqual({ text: "hello\n\n\n" });
    expect(out).toBe("---\r\ntext: |+\r\n  hello\r\n\r\n\r\n\r\n---\r\n");
  });

  it("R8: keep-chomp already LAST on CRLF, the key before it CHANGED", () => {
    const raw = "---\r\ngone: 1\r\ntext: |+\r\n  hello\r\n\r\n\r\n\r\n---\r\n";
    expect(read(raw)).toEqual({ gone: 1, text: "hello\n\n\n" });
    const out = setKey(raw, "gone", 9);
    expect(read(out)).toEqual({ gone: 9, text: "hello\n\n\n" });
  });

  it("R9: a CLIP (`|`) scalar ending the block gains no blank line", () => {
    const raw = "---\ngone: 1\ntext: |\n  hello\n---\n";
    expect(read(raw)).toEqual({ gone: 1, text: "hello\n" });
    const out = removeKeys(raw, "gone");
    expect(out).toBe("---\ntext: |\n  hello\n---\n");
    expect(read(out)).toEqual({ text: "hello\n" });
  });

  it("R10: a genuine trailing blank source line is not duplicated when a key changes", () => {
    const out = setKey("---\na: 1\n\n---\nbody\n", "a", 9);
    expect(out).toBe("---\na: 9\n\n---\nbody\n");
    expect(read(out)).toEqual({ a: 9 });
  });

  it("R11: the reported removal case, with a body and two trailing newlines", () => {
    const raw = "---\ntext: |+\n  hello\n\n\nright: 2\n---\nbody\n";
    expect(read(raw)).toEqual({ text: "hello\n\n\n", right: 2 });
    expect(read(removeKeys(raw, "right"))).toEqual({ text: "hello\n\n\n" });
    const two = "---\ntext: |+\n  hello\n\nright: 2\n---\nbody\n";
    expect(read(two)).toEqual({ text: "hello\n\n", right: 2 });
    expect(read(removeKeys(two, "right"))).toEqual({ text: "hello\n\n" });
  });

  it("R12: a non-string top-level key in an ALIAS block re-parses and does not throw", () => {
    const raw = "---\n1: &x [1, 2]\nb: *x\n---\n";
    expect(read(raw)).toEqual({ "1": [1, 2], b: [1, 2] });
    expect(() => read(setKey(raw, "b", 9))).not.toThrow();
    expect(read(setKey(raw, "b", 9))).toEqual({ "1": [1, 2], b: 9 });
    expect(() => read(removeKeys(raw, "b"))).not.toThrow();
    expect(read(removeKeys(raw, "b"))).toEqual({ "1": [1, 2] });
  });

  // N1: a mapping keyed `1:`/`true:` reaches the emitter as the JS string "1"/"true", and the
  // Document API matches a plain string against the key NODE's value — so a numeric key was
  // neither found nor replaced: remove wrote the block back unchanged and reported success, set
  // appended a second, string-keyed line beside the existing one.
  it("N1: a NUMERIC key in an alias block is removed, not silently skipped", () => {
    const raw = "---\n1: &x [1, 2]\nb: *x\nc: 3\n---\n";
    expect(read(raw)).toEqual({ "1": [1, 2], b: [1, 2], c: 3 });
    const out = removeKeys(raw, "1");
    expect(out).not.toBe(raw);
    expect(read(out)).toEqual({ b: [1, 2], c: 3 });
    expect(out).not.toContain("*x");
  });

  it("N1: a NUMERIC key in an alias block is REPLACED, not duplicated", () => {
    const out = setKey("---\n1: &x [1, 2]\nb: *x\nc: 3\n---\n", "1", 9);
    expect(read(out)).toEqual({ "1": 9, b: [1, 2], c: 3 });
    expect(out.match(/^\s*("?1"?):/gm)).toHaveLength(1);
  });

  it("N1: a BOOLEAN key in an alias block is replaced and removed", () => {
    const raw = "---\ntrue: &x [1, 2]\nb: *x\n---\n";
    expect(read(raw)).toEqual({ true: [1, 2], b: [1, 2] });
    expect(read(setKey(raw, "true", 9))).toEqual({ true: 9, b: [1, 2] });
    expect(read(removeKeys(raw, "true"))).toEqual({ b: [1, 2] });
  });

  // N2: doc.set mutates a Scalar in place, so a scalar-to-scalar change kept the node's anchor
  // while a collection-to-scalar change dropped it. The anchor on a CHANGED node goes when nothing
  // aliases it any more; one on an untouched key is left exactly as the author wrote it.
  it("N2: an orphaned anchor on a CHANGED scalar is dropped", () => {
    const out = setKey("---\na: &x 1\nb: *x\n---\n", "a", 99);
    expect(out).toBe("---\na: 99\nb: 1\n---\n");
    expect(read(out)).toEqual({ a: 99, b: 1 });
  });

  it("N2: an anchor still referenced by a surviving alias is kept", () => {
    const out = setKey("---\na: &x [1, 2]\nb: *x\nc: 3\n---\n", "c", 9);
    expect(out).toContain("&x");
    expect(out).toContain("*x");
    expect(read(out)).toEqual({ a: [1, 2], b: [1, 2], c: 9 });
  });

  it("N2: an orphaned anchor on an UNTOUCHED key is left alone", () => {
    const out = setKey("---\na: &x 1\nb: *x\n---\n", "b", 2);
    expect(out).toBe("---\na: &x 1\nb: 2\n---\n");
    expect(read(out)).toEqual({ a: 1, b: 2 });
  });

  // C1: `1:` and `'1':` are distinct YAML keys that collapse to the same JS key, where the LAST
  // one wins. The emitter must follow that: a set updates the last matching pair, a remove drops
  // ALL of them (a shadowed duplicate must never resurface), a read follows the last.
  const COLLIDE = "---\n1: &x first\n'1': second\nb: *x\n---\n";

  it("C1: colliding keys — a set updates the pair the reader actually sees", () => {
    expect(read(COLLIDE)).toEqual({ "1": "second", b: "first" });
    expect(read(setKey(COLLIDE, "1", 9))).toEqual({ "1": 9, b: "first" });
  });

  it("C1: colliding keys — a remove drops every matching pair", () => {
    expect(read(removeKeys(COLLIDE, "1"))).toEqual({ b: "first" });
  });

  it("C1: the same for a BOOLEAN key collision", () => {
    const raw = "---\ntrue: &x first\n'true': second\nb: *x\n---\n";
    expect(read(raw)).toEqual({ true: "second", b: "first" });
    expect(read(setKey(raw, "true", 9))).toEqual({ true: 9, b: "first" });
    expect(read(removeKeys(raw, "true"))).toEqual({ b: "first" });
  });

  // C2: assigning a keep-chomp value to a key whose ORIGINAL scalar was clip/strip leaves the
  // source's blank separator line sitting right after the new `|+` scalar, where it is no longer a
  // separator but content. Value correctness wins: those blank lines go.
  it("C2: a keep-chomp assignment does not absorb the blank line after it (first)", () => {
    const raw = "---\ntext: |\n  hello\n\nright: 2\n---\n";
    expect(read(raw)).toEqual({ text: "hello\n", right: 2 });
    expect(read(setKey(raw, "text", "changed\n\n"))).toEqual({ text: "changed\n\n", right: 2 });
  });

  it("C2: the same in the MIDDLE of the block", () => {
    const raw = "---\nleft: 1\ntext: |\n  hello\n\nright: 2\n---\n";
    expect(read(setKey(raw, "text", "changed\n\n"))).toEqual({
      left: 1,
      text: "changed\n\n",
      right: 2,
    });
  });

  it("C2: the same as the LAST key of the block", () => {
    const raw = "---\nleft: 1\ntext: |\n  hello\n\n---\n";
    expect(read(setKey(raw, "text", "changed\n\n"))).toEqual({ left: 1, text: "changed\n\n" });
  });

  it("C2: the same from a STRIP (`|-`) original", () => {
    const raw = "---\ntext: |-\n  hello\n\nright: 2\n---\n";
    expect(read(setKey(raw, "text", "changed\n\n"))).toEqual({ text: "changed\n\n", right: 2 });
  });

  it("C2: the same on CRLF", () => {
    const raw = "---\r\ntext: |\r\n  hello\r\n\r\nright: 2\r\n---\r\n";
    expect(read(setKey(raw, "text", "changed\n\n"))).toEqual({ text: "changed\n\n", right: 2 });
  });

  // P2: an ALIAS used as a mapping KEY. `*key : third` is a third pair whose key resolves to the
  // same JS key as `1:` and `'1':`, so materializing it (its anchor sits under a key being
  // replaced) turns the block into two literal `1:` pairs — "Map keys must be unique" on the next
  // read. The pairs the reader cannot see go with it; their anchors were already copied out.
  const ALIAS_KEY = "---\n1: &key 1\n'1': second\n*key : third\nb: *key\n---\n";

  it("P2: setting a key whose alias-KEY pair collides emits valid, exact YAML", () => {
    expect(read(ALIAS_KEY)).toEqual({ "1": "third", b: 1 });
    const out = setKey(ALIAS_KEY, "1", 9);
    expect(() => read(out)).not.toThrow();
    expect(read(out)).toEqual({ "1": 9, b: 1 });
  });

  it("P2: removing that key drops every pair it owns", () => {
    expect(read(removeKeys(ALIAS_KEY, "1"))).toEqual({ b: 1 });
  });

  it("P2: the anchor under the pair being REPLACED is still found", () => {
    const raw = "---\n1: 1\n'1': &key second\n*key : third\nb: *key\n---\n";
    expect(read(raw)).toEqual({ "1": "second", second: "third", b: "second" });
    const out = setKey(raw, "1", 9);
    expect(() => read(out)).not.toThrow();
    expect(read(out)).toEqual({ "1": 9, second: "third", b: "second" });
  });

  it("P2: an alias KEY that collides with nothing round-trips", () => {
    const raw = "---\nkey: &k fresh\n*k : third\nb: 1\n---\n";
    expect(read(raw)).toEqual({ key: "fresh", fresh: "third", b: 1 });
    expect(read(setKey(raw, "b", 9))).toEqual({ key: "fresh", fresh: "third", b: 9 });
    expect(read(setKey(raw, "fresh", 9))).toEqual({ key: "fresh", fresh: 9, b: 1 });
  });

  // P3: a key whose ONLY pair is an alias key is invisible to a scan over the key nodes' string
  // form — `*k` reads as "*k", never as "fresh" — so a remove silently no-ops and a set appends a
  // second pair below the shadowing one. Every alias key resolving to a scalar is materialized
  // into that scalar before any key is addressed; `? *k` byte forms are given up for it.
  const ALIAS_KEY_ONLY = "---\nkey: &k fresh\n*k : third\nb: 1\n---\n";

  it("P3: removing a key owned only by an alias KEY drops the pair", () => {
    expect(read(ALIAS_KEY_ONLY)).toEqual({ key: "fresh", fresh: "third", b: 1 });
    const out = removeKeys(ALIAS_KEY_ONLY, "fresh");
    expect(() => read(out)).not.toThrow();
    expect(read(out)).toEqual({ key: "fresh", b: 1 });
  });

  it("P3: removing a key drops its alias KEY pair as well as its literal one", () => {
    const raw = "---\nkey: &k fresh\n? *k\n: third\nfresh: 9\n---\n";
    expect(read(raw)).toEqual({ key: "fresh", fresh: 9 });
    const out = removeKeys(raw, "fresh");
    expect(() => read(out)).not.toThrow();
    expect(read(out)).toEqual({ key: "fresh" });
  });

  it("P3: setting a key owned only by an alias KEY leaves exactly one pair", () => {
    const out = setKey(ALIAS_KEY_ONLY, "fresh", 9);
    expect(() => read(out)).not.toThrow();
    expect(read(out)).toEqual({ key: "fresh", fresh: 9, b: 1 });
    expect(out.match(/^fresh:/gm)?.length).toBe(1);
    expect(out).not.toContain("*k");
  });

  it("P3: setting an UNRELATED key leaves the alias-key pair readable", () => {
    const out = setKey(ALIAS_KEY_ONLY, "b", 2);
    expect(() => read(out)).not.toThrow();
    expect(read(out)).toEqual({ key: "fresh", fresh: "third", b: 2 });
  });

  // P4: materializing an alias key can land it in a collision group the caller never touched —
  // `*key` resolves to `1`, which is already a pair. Nothing else collapses a group no edit names,
  // so the group keeps the pair the reader resolves and the dropped pairs' anchors are copied into
  // their aliases first, exactly as a set on that key would.
  const ALIAS_KEY_UNTOUCHED = "---\n1: &key 1\n'1': second\n*key : third\nb: *key\n---\n";

  it("P4: setting an unrelated key collapses the alias KEY's collision group", () => {
    expect(read(ALIAS_KEY_UNTOUCHED)).toEqual({ "1": "third", b: 1 });
    const out = setKey(ALIAS_KEY_UNTOUCHED, "b", 2);
    expect(() => read(out)).not.toThrow();
    expect(read(out)).toEqual({ "1": "third", b: 2 });
    expect(out.match(/^'?1'?:/gm)?.length).toBe(1);
  });

  it("P4: an alias under a dropped pair keeps the value it had", () => {
    const out = setKey(ALIAS_KEY_UNTOUCHED, "c", 5);
    expect(() => read(out)).not.toThrow();
    expect(read(out)).toEqual({ "1": "third", b: 1, c: 5 });
  });

  it("P4: the same collapse on CRLF", () => {
    const raw = "---\r\n1: &key 1\r\n'1': second\r\n*key : third\r\nb: *key\r\n---\r\n";
    const out = setKey(raw, "b", 2);
    expect(() => read(out)).not.toThrow();
    expect(read(out)).toEqual({ "1": "third", b: 2 });
    expect(out.split("\n").every((l) => l === "" || l.endsWith("\r"))).toBe(true);
  });

  it("C2: a CLIP assignment keeps the blank separator line", () => {
    const raw = "---\ntext: |\n  hello\n\nright: 2\n---\n";
    const out = setKey(raw, "text", "changed\n");
    expect(out).toBe("---\ntext: |\n  changed\n\nright: 2\n---\n");
    expect(read(out)).toEqual({ text: "changed\n", right: 2 });
  });
});
