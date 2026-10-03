// rewriteLinks rewrites links in a note's PROPERTIES on purpose (rename propagation, Obsidian
// parity), so the new target has to be written as YAML, not pasted into the text: a target with a
// quote, ": ", " #", a leading "-" or a backslash used to break the whole frontmatter block.
// The rewrite escapes per the scalar's own style, then re-parses to prove the property holds the
// intended link text; a property that cannot be proven is left alone and named in `warnings`.
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { parseNote } from "../src/vault/frontmatter";
import { rewriteLinks } from "../src/vault/rewrite";
import { makeTestVault } from "./m1-helpers";

const TARGETS = [
  'a"b',
  "it's",
  "a: b",
  "a #b",
  "-lead",
  "back\\slash",
  "café ☕ 日本",
  `all'of"it: #at \\ once`,
];

const toNew = (t: string) => (target: string) => (target === "Old" ? t : null);

/** The parsed frontmatter, with every "Old" inside a string leaf replaced by `t` — what the
 *  property values must equal after the rewrite. */
function expectedFm(raw: string, t: string): unknown {
  const swap = (v: unknown): unknown => {
    if (typeof v === "string") return v.split("Old").join(t);
    if (Array.isArray(v)) return v.map(swap);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)]));
    return v;
  };
  return swap(parseNote(raw).frontmatter);
}

const BODY = "Body [[Old]] and ![[Old|pic]] and [m](Old).\n";

const FORMS: Record<string, string> = {
  "double-quoted scalar": 'up: "[[Old]]"',
  "single-quoted scalar": "up: '[[Old]]'",
  "plain scalar": "up: see [[Old]]",
  "double-quoted block list": 'up:\n  - "[[Keep]]"\n  - "[[Old]]"',
  "single-quoted block list": "up:\n  - '[[Old]]'\n  - '[[Keep]]'",
  "plain block list": "up:\n  - see [[Old]]",
  "flow list": 'up: ["[[Keep]]", "[[Old]]"]',
  "aliased + heading": 'up: "[[Old#Sec|shown]]"',
  "nested map value": 'meta:\n  parent: "[[Old]]"',
};

describe("rewriteLinks: property links are written as valid YAML", () => {
  for (const [form, fmText] of Object.entries(FORMS)) {
    for (const t of TARGETS) {
      it(`${form} -> ${JSON.stringify(t)}`, () => {
        const raw = `---\n${fmText}\ntitle: T\n---\n${BODY}`;
        const out = rewriteLinks(raw, toNew(t));
        expect(out.warnings).toEqual([]);
        // frontmatter still parses, and the property holds the intended link text
        expect(parseNote(out.text).frontmatter).toEqual(expectedFm(raw, t));
        // the body is rewritten exactly as before: raw target, no YAML escaping
        expect(splitBody(out.text)).toBe(`Body [[${t}]] and ![[${t}|pic]] and [m](${t}).\n`);
        // the other key survives
        expect(out.text).toContain("\ntitle: T\n---\n");
      });
    }
  }
});

function splitBody(text: string): string {
  return parseNote(text).body;
}

describe("rewriteLinks: byte-for-byte outside the rewritten scalar", () => {
  it("keeps comments, other keys and the quote style; escapes only inside the scalar", () => {
    const raw = '---\n# lead comment\nkeep: [1,   2]\nup: "[[Old]]" # why\nz: 01234\n---\nbody\n';
    const out = rewriteLinks(raw, toNew('a"b'));
    expect(out.text).toBe(
      '---\n# lead comment\nkeep: [1,   2]\nup: "[[a\\"b]]" # why\nz: 01234\n---\nbody\n',
    );
    expect(out.count).toBe(1);
  });

  it("single-quoted: doubles the quote and keeps single quotes", () => {
    const out = rewriteLinks("---\nup: '[[Old]]'\n---\n", toNew("it's"));
    expect(out.text).toBe("---\nup: '[[it''s]]'\n---\n");
  });

  it("plain stays plain when the new value needs no quoting", () => {
    const out = rewriteLinks("---\nup: see [[Old]]\n---\n", toNew("New"));
    expect(out.text).toBe("---\nup: see [[New]]\n---\n");
  });

  it("plain switches to double-quoted only when it must", () => {
    const out = rewriteLinks("---\nup: see [[Old]]\n---\n", toNew("a: b"));
    expect(out.text).toBe('---\nup: "see [[a: b]]"\n---\n');
  });

  it("matches a link that an earlier rewrite already escaped, by its VALUE", () => {
    const raw = '---\nup: "[[a\\"b]]"\n---\n';
    const out = rewriteLinks(raw, (t) => (t === 'a"b' ? "c" : null));
    expect(out.text).toBe('---\nup: "[[c]]"\n---\n');
    expect(out.count).toBe(1);
  });

  it("keeps CRLF line endings", () => {
    const raw = '---\r\nup: "[[Old]]"\r\n---\r\nB [[Old]]\r\n';
    const out = rewriteLinks(raw, toNew('a"b'));
    expect(out.text).toBe('---\r\nup: "[[a\\"b]]"\r\n---\r\nB [[a"b]]\r\n');
  });

  it("an unquoted [[X]] is a nested list, not a link: left alone, as extractPropertyLinks does", () => {
    const raw = "---\nup: [[Old]]\n---\nB [[Old]]\n";
    const out = rewriteLinks(raw, toNew("New"));
    expect(out.text).toBe("---\nup: [[Old]]\n---\nB [[New]]\n");
    expect(out.count).toBe(1);
  });

  it("a link in a frontmatter comment is not a property and is left alone", () => {
    const raw = '---\n# see [[Old]]\nup: "[[Old]]"\n---\n';
    const out = rewriteLinks(raw, toNew("New"));
    expect(out.text).toBe('---\n# see [[Old]]\nup: "[[New]]"\n---\n');
  });

  it("block scalars take the raw target (a block holds literal text)", () => {
    const raw = "---\nnote: |\n  see [[Old]]\n  more\n---\n";
    const out = rewriteLinks(raw, toNew('a"b: #c'));
    expect(out.text).toBe('---\nnote: |\n  see [[a"b: #c]]\n  more\n---\n');
    expect(parseNote(out.text).frontmatter).toEqual({ note: 'see [[a"b: #c]]\nmore\n' });
  });
});

describe("rewriteLinks: a property that cannot be proven is refused, atomically per note", () => {
  // A newline in the new target used to be the one thing a block scalar could not hold, so these two
  // cases asserted a per-property warning while the body link was written across two lines. That body
  // write is the wikilink injection (a link target spliced into `[[...]]` closes it, or splits it,
  // and writes text around it), so the whole note's rewrite is now refused instead — see
  // wiki-safe-names.test.ts. The tests keep their fixtures and pin the stronger outcome.
  it("a newline target refuses the note's whole rewrite: frontmatter and body both untouched", () => {
    const fm = '---\nnote: |\n  see [[Old]]\nother: "[[Old]]"\n---\n';
    expect(() => rewriteLinks(`${fm}B [[Old]]\n`, toNew("x\ny"))).toThrow(/single link/);
  });

  it("a newline target in a block scalar is refused, not half-applied", () => {
    const fm = "---\nnote: |\n  see [[Old]]\n---\n";
    expect(() => rewriteLinks(`${fm}B\n`, toNew("x\ny"))).toThrow(/single link/);
  });

  it("an unparseable frontmatter block is never made worse: rewritten as text, with a warning", () => {
    const raw = '---\nup: "[[Old]]"\nbad: [unclosed\n---\nB [[Old]]\n';
    const out = rewriteLinks(raw, toNew("New"));
    expect(out.text).toBe('---\nup: "[[New]]"\nbad: [unclosed\n---\nB [[New]]\n');
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]?.message).toMatch(/not valid YAML/);
  });
});

type Data = Record<string, unknown>;
const dataOf = (r: ToolResult): Data => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as Data;
};
const hashOf = (r: ToolResult): string => {
  if (r.ok) throw new Error("expected an error result");
  return String((r.error.details as { args_hash?: string }).args_hash);
};

const GUIDE =
  '---\nauthor: "[[Old]]"\nseries:\n  - "[[Old|alias]]"\n  - "[[Keep]]"\nsee: see [[Old]]\ntitle: T\n---\nBody [[Old]].\n';

describe("end to end: rewrite_link and move_note keep frontmatter valid", () => {
  for (const t of ['a"b', "it's", "a: b", "-lead", "café ☕"]) {
    it(`rewrite_link to_target ${JSON.stringify(t)}`, async () => {
      const v = makeTestVault({
        files: { "Old.md": "# Old\n", "Keep.md": "# Keep\n", "Guide.md": GUIDE },
      });
      try {
        const input = { vault: "test", from_target: "Old", to_target: t, dry_run: false };
        const need = await v.call("rewrite_link", input);
        const done = await v.call("rewrite_link", input, {
          elicitToken: issueElicitToken(v.db, {
            vaultId: v.id,
            toolName: "rewrite_link",
            argsHash: hashOf(need),
            caller: "test",
          }),
        });
        expect(dataOf(done).warnings).toBeUndefined();
        const after = v.read("Guide.md");
        const p = parseNote(after);
        expect(p.frontmatter).toEqual({
          author: `[[${t}]]`,
          series: [`[[${t}|alias]]`, "[[Keep]]"],
          see: `see [[${t}]]`,
          title: "T",
        });
        expect(p.body).toBe(`Body [[${t}]].\n`);
      } finally {
        v.cleanup();
      }
    });
  }

  it("rewrite_link refuses a newline target outright (dry run too), writing nothing", async () => {
    // Was: a per-property warning while the body link was written across two lines. That body write
    // is the wikilink injection, so the whole rewrite is refused; see wiki-safe-names.test.ts.
    const guide = '---\nnote: |\n  see [[Old]]\nauthor: "[[Old]]"\n---\nBody [[Old]].\n';
    const v = makeTestVault({ files: { "Old.md": "# Old\n", "Guide.md": guide } });
    try {
      const dry = await v.call("rewrite_link", {
        vault: "test",
        from_target: "Old",
        to_target: "x\ny",
      });
      expect(dry.ok).toBe(false);
      if (!dry.ok) expect(dry.error.code).toBe("invalid_input");
      expect(v.read("Guide.md")).toBe(guide);
    } finally {
      v.cleanup();
    }
  });

  // (`a #b` is no longer a valid destination: a new note name cannot hold `#`.)
  for (const name of ['a"b', "it's", "-lead", "café ☕"]) {
    // Windows forbids a double quote in a filename, so that name cannot exist on disk there.
    it.skipIf(process.platform === "win32" && name.includes('"'))(
      `move_note onto ${JSON.stringify(name)}.md repoints property links as valid YAML`,
      async () => {
        const v = makeTestVault({
          files: { "Old.md": "# Old\n", "Keep.md": "# Keep\n", "Guide.md": GUIDE },
        });
        try {
          const input = { vault: "test", from: "Old.md", to: `people/${name}.md` };
          let res = await v.call("move_note", input);
          if (!res.ok)
            res = await v.call("move_note", input, {
              elicitToken: issueElicitToken(v.db, {
                vaultId: v.id,
                toolName: "move_note",
                argsHash: hashOf(res),
                caller: "test",
              }),
            });
          expect(dataOf(res).warnings).toBeUndefined();
          const p = parseNote(v.read("Guide.md"));
          expect(p.frontmatter).toEqual({
            author: `[[${name}]]`,
            series: [`[[${name}|alias]]`, "[[Keep]]"],
            see: `see [[${name}]]`,
            title: "T",
          });
          expect(p.body).toBe(`Body [[${name}]].\n`);
        } finally {
          v.cleanup();
        }
      },
    );
  }
});
