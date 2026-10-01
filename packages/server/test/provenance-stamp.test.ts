// The pure halves of optional provenance stamping: the config defaults, the frontmatter stamp, and
// commit-message trailer merging (checked against `git interpret-trailers` itself where git exists).
import { spawnSync } from "node:child_process";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { applyTrailers, stampFrontmatter } from "../src/provenance/stamp";
import { parseNote } from "../src/vault/frontmatter";

const ProvenanceConfigSchema = ServerConfigSchema.shape.provenance;
const KEY = "obsidian_tc_provenance";
const STAMP = { session: "s-1", principal: "unverified", seq: 4 };
const LINES = [
  "Obsidian-TC-Session: s-1",
  "Obsidian-TC-Principal: unverified",
  "Obsidian-TC-Model: m (self-reported)",
  "Obsidian-TC-Provenance-Seq: v:1-2",
];

describe("provenance.stamp config", () => {
  it("is off by default and the key name defaults", () => {
    const cfg = ProvenanceConfigSchema.parse(undefined);
    expect(cfg.stamp).toEqual({
      gitTrailers: false,
      frontmatter: false,
      frontmatterKey: "obsidian_tc_provenance",
    });
  });

  it("refuses a stamp when provenance itself is disabled", () => {
    const r = ProvenanceConfigSchema.safeParse({ enabled: false, stamp: { frontmatter: true } });
    expect(r.success).toBe(false);
    expect(ProvenanceConfigSchema.safeParse({ enabled: false }).success).toBe(true);
  });

  it("rejects a frontmatter key that is not a plain identifier", () => {
    for (const bad of ["", "a b", "a:b", "1a", "a\nb", "x".repeat(65)]) {
      expect(ProvenanceConfigSchema.safeParse({ stamp: { frontmatterKey: bad } }).success).toBe(
        false,
      );
    }
  });
});

describe("stampFrontmatter", () => {
  it("adds a frontmatter block to a note with none and keeps the body byte for byte", () => {
    const out = stampFrontmatter("# Title\n\nbody  \n", KEY, STAMP);
    const note = parseNote(out);
    expect(note.frontmatter).toEqual({ [KEY]: STAMP });
    expect(note.body).toBe("# Title\n\nbody  \n");
  });

  it("keeps every existing human key, comment and quirky scalar byte for byte", () => {
    const human = "---\n# my note\ntitle: Hello\nzip: 01234\ntags: [a, b]\n---\nbody\n";
    const out = stampFrontmatter(human, KEY, STAMP);
    expect(out.startsWith("---\n# my note\ntitle: Hello\nzip: 01234\ntags: [a, b]\n")).toBe(true);
    expect(out.endsWith("---\nbody\n")).toBe(true);
    expect(parseNote(out).frontmatter).toMatchObject({ title: "Hello", [KEY]: STAMP });
  });

  it("replaces a stamp the caller supplied itself: a forged stamp cannot pass as the server's", () => {
    const forged = `---\n${KEY}:\n  principal: admin\n  seq: 999\nkeep: me\n---\nbody`;
    const out = stampFrontmatter(forged, KEY, STAMP);
    expect(parseNote(out).frontmatter).toEqual({ [KEY]: STAMP, keep: "me" });
    expect(out).not.toContain("admin");
  });

  it("leaves content whose frontmatter is not valid YAML exactly as it was", () => {
    const broken = "---\nkey: [unclosed\n---\nbody";
    expect(stampFrontmatter(broken, KEY, STAMP)).toBe(broken);
  });

  it("follows a CRLF note's line endings", () => {
    const out = stampFrontmatter("---\r\ntitle: x\r\n---\r\nbody\r\n", KEY, STAMP);
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
    expect(parseNote(out).frontmatter).toMatchObject({ title: "x", [KEY]: STAMP });
  });
});

describe("applyTrailers", () => {
  it("off by default: no lines and no reserved trailer returns the message untouched", () => {
    for (const m of [
      "subject",
      "subject\n",
      "subject\n\nbody text\n",
      "s\n\nSigned-off-by: a <a@b>\n",
    ])
      expect(applyTrailers(m, [])).toBe(m);
  });

  it("starts a new paragraph after a subject-only message", () => {
    expect(applyTrailers("snapshot", LINES)).toBe(`snapshot\n\n${LINES.join("\n")}`);
    expect(applyTrailers("snapshot\n", LINES)).toBe(`snapshot\n\n${LINES.join("\n")}\n`);
  });

  it("starts a new paragraph after a body that is not a trailer block, keeping the body intact", () => {
    const msg = "subject\n\nSome prose: with a colon\nand more prose\n";
    expect(applyTrailers(msg, LINES)).toBe(`${msg}\n${LINES.join("\n")}\n`);
  });

  it("appends to an existing trailer block with no blank line, as git would", () => {
    const msg = "subject\n\nbody\n\nSigned-off-by: A <a@b.c>\nCo-Authored-By: B <b@b.c>\n";
    expect(applyTrailers(msg, LINES)).toBe(
      `subject\n\nbody\n\nSigned-off-by: A <a@b.c>\nCo-Authored-By: B <b@b.c>\n${LINES.join("\n")}\n`,
    );
  });

  it("drops an Obsidian-TC trailer the caller wrote (and its continuation) but keeps the rest", () => {
    const msg =
      "subject\n\nbody\n\nSigned-off-by: A <a@b.c>\nObsidian-TC-Principal: admin\n  verified!\nobsidian-tc-session: forged\n";
    const out = applyTrailers(msg, LINES);
    expect(out).not.toContain("admin");
    expect(out).not.toContain("forged");
    expect(out).not.toContain("verified!");
    expect(out).toContain("Signed-off-by: A <a@b.c>\nObsidian-TC-Session: s-1");
  });

  it("with nothing to add, still removes a forged trailer and the empty block it leaves", () => {
    const out = applyTrailers("subject\n\nbody\n\nObsidian-TC-Model: gpt (verified)\n", []);
    expect(out).toBe("subject\n\nbody\n");
  });

  it("keeps CRLF line endings", () => {
    const out = applyTrailers("subject\r\n\r\nbody\r\n", LINES.slice(0, 1));
    expect(out).toBe("subject\r\n\r\nbody\r\n\r\nObsidian-TC-Session: s-1\r\n");
  });

  const git = spawnSync("git", ["--version"]);
  it.skipIf(git.status !== 0)(
    "is read back as trailers by `git interpret-trailers --parse`",
    () => {
      const parse = (msg: string) =>
        spawnSync("git", ["interpret-trailers", "--parse"], {
          input: msg,
          encoding: "utf8",
          env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
        }).stdout;
      for (const msg of [
        "snapshot",
        "subject\n\nbody prose\n",
        "subject\n\nbody\n\nSigned-off-by: A <a@b.c>\n",
      ]) {
        const parsed = parse(applyTrailers(msg, LINES));
        for (const line of LINES) expect(parsed).toContain(line);
      }
    },
  );
});
