// blockingDelta: a write is judged by the blocking violations it ADDS to a note, keyed per value. A new
// note counts all of its blocking violations, a partial fix and an edit that adds nothing return none,
// a second bad value on a property that already had one counts, a broken-YAML before is checkNote(null),
// and a warn-level rule never appears.
import { afterEach, describe, expect, it } from "vitest";
import { blockingDelta, checkNote } from "../src/conventions/check";
import { resolveConventions } from "../src/conventions/resolve";
import { parseNoteLenient } from "../src/vault/frontmatter";
import { makeTestVault, type TestVault } from "./m1-helpers";

let v: TestVault | undefined;
afterEach(() => {
  v?.cleanup();
  v = undefined;
});

const schema = (severity: string): string =>
  `---\nconventions:\n  frontmatter:\n    required: [type]\n    values:\n      status: [draft, current]\n    severity: ${severity}\n---\n# rules\n`;

function effectiveOf(text: string) {
  v?.cleanup();
  v = makeTestVault({ files: { "SCHEMA.md": text, "n.md": "x" } });
  return resolveConventions(
    { vaultId: v.id, root: v.root, acl: v.acl, grantedScopes: ["*"] },
    "n.md",
  );
}

const fm = (raw: string) => parseNoteLenient(raw, "n.md").frontmatter;
const BLOCKING = '{ type: block, status: block, "*": warn }';
const keys = (ws: { code: string; property?: string }[]) =>
  ws.map((w) => `${w.code}:${w.property ?? ""}`);

describe("blockingDelta", () => {
  it("a new note counts every blocking violation", () => {
    const eff = effectiveOf(schema(BLOCKING));
    const d = blockingDelta(eff, "n.md", undefined, fm("---\nstatus: stale\n---\n"));
    expect(keys(d)).toEqual(["missing_required:type", "value_not_allowed:status"]);
    expect(d.every((w) => w.level === "block")).toBe(true);
  });

  it("an edit that adds a blocking violation is returned", () => {
    const eff = effectiveOf(schema(BLOCKING));
    const d = blockingDelta(
      eff,
      "n.md",
      fm("---\ntype: meeting\nstatus: current\n---\n"),
      fm("---\ntype: meeting\nstatus: stale\n---\n"),
    );
    expect(keys(d)).toEqual(["value_not_allowed:status"]);
  });

  it("an edit to an already-broken note that adds nothing new returns none", () => {
    const eff = effectiveOf(schema(BLOCKING));
    const d = blockingDelta(
      eff,
      "n.md",
      fm("---\ntype: meeting\nstatus: stale\n---\n"),
      fm("---\ntype: meeting\nstatus: stale\ntitle: x\n---\n"),
    );
    expect(d).toEqual([]);
  });

  it("a partial fix returns none", () => {
    const eff = effectiveOf(schema(BLOCKING));
    const d = blockingDelta(
      eff,
      "n.md",
      fm("---\ntype: meeting\nstatus: [stale, old]\n---\n"),
      fm("---\ntype: meeting\nstatus: [stale]\n---\n"),
    );
    expect(d).toEqual([]);
  });

  it("a second bad value on a property that already had one counts, per value", () => {
    const eff = effectiveOf(schema(BLOCKING));
    const d = blockingDelta(
      eff,
      "n.md",
      fm("---\ntype: meeting\nstatus: stale\n---\n"),
      fm("---\ntype: meeting\nstatus: [stale, old]\n---\n"),
    );
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ code: "value_not_allowed", property: "status", values: ["old"] });
    expect(d[0]?.message).toContain('"old"');
    expect(d[0]?.message).not.toContain('"stale"');
  });

  it("a broken-YAML before is checkNote(null): its missing fields are not new", () => {
    const eff = effectiveOf(schema(BLOCKING));
    const d = blockingDelta(eff, "n.md", null, fm("---\nstatus: stale\n---\n"));
    expect(keys(d)).toEqual(["value_not_allowed:status"]);
  });

  it("a warn-level rule never appears", () => {
    const eff = effectiveOf(schema('{ status: warn, "*": warn }'));
    expect(blockingDelta(eff, "n.md", undefined, fm("---\nstatus: stale\n---\n"))).toEqual([]);
  });

  // A violation's identity is (code, property, value): a change of type relabels nothing.
  const PROBE = `---
conventions:
  frontmatter:
    required: [type, status]
    values:
      type: [meeting, research]
      status: [draft, current]
    severity: {"*": block}
---
# rules
`;

  it("a type fix that leaves status stale adds nothing (type not in the key)", () => {
    const eff = effectiveOf(PROBE);
    const d = blockingDelta(
      eff,
      "n.md",
      fm("---\ntype: meating\nstatus: stale\n---\n"),
      fm("---\ntype: meeting\nstatus: stale\n---\n"),
    );
    expect(d).toEqual([]);
  });

  it("adding a type to a note that lacked one adds nothing new", () => {
    const eff = effectiveOf(PROBE);
    const d = blockingDelta(
      eff,
      "n.md",
      fm("---\ntitle: x\n---\n"),
      fm("---\ntype: meeting\n---\n"),
    );
    expect(d).toEqual([]);
  });

  it("adding a type to a broken-YAML note adds nothing new", () => {
    const eff = effectiveOf(PROBE);
    expect(blockingDelta(eff, "n.md", null, fm("---\ntype: meeting\n---\n"))).toEqual([]);
  });

  it("fixing a several-types list adds nothing new", () => {
    const eff = effectiveOf(PROBE);
    const d = blockingDelta(
      eff,
      "n.md",
      fm("---\ntype: [meeting, research]\nstatus: stale\n---\n"),
      fm("---\ntype: meeting\nstatus: stale\n---\n"),
    );
    expect(d).toEqual([]);
  });

  it("a new bad type value is reported; the unchanged status is not", () => {
    const eff = effectiveOf(PROBE);
    const d = blockingDelta(
      eff,
      "n.md",
      fm("---\ntype: foo\nstatus: stale\n---\n"),
      fm("---\ntype: bar\nstatus: stale\n---\n"),
    );
    expect(keys(d)).toEqual(["value_not_allowed:type"]);
    expect(d[0]?.values).toEqual(["bar"]);
  });

  // A non-scalar item masks the scalar values beside it: they are judged in both notes.
  it("removing a non-scalar item does not reveal a pre-existing bad value", () => {
    const eff = effectiveOf(schema(BLOCKING));
    const d = blockingDelta(
      eff,
      "n.md",
      fm("---\ntype: meeting\nstatus: [stale, {a: 1}]\n---\n"),
      fm("---\ntype: meeting\nstatus: [stale]\n---\n"),
    );
    expect(d).toEqual([]);
  });

  it("a newly added bad value beside a masked one is reported", () => {
    const eff = effectiveOf(schema(BLOCKING));
    const d = blockingDelta(
      eff,
      "n.md",
      fm("---\ntype: meeting\nstatus: [stale, {a: 1}]\n---\n"),
      fm("---\ntype: meeting\nstatus: [stale, wip]\n---\n"),
    );
    expect(keys(d)).toEqual(["value_not_allowed:status"]);
    expect(d[0]?.values).toEqual(["wip"]);
  });

  it("a partial message names the full allowed list, past the 50-value scan cap", () => {
    const many = Array.from({ length: 60 }, (_, i) => `v${i}`);
    const eff = effectiveOf(
      `---\nconventions:\n  frontmatter:\n    required: [type]\n    values:\n      status: [${many.join(", ")}]\n    severity: ${BLOCKING}\n---\n# rules\n`,
    );
    const d = blockingDelta(
      eff,
      "n.md",
      fm("---\ntype: meeting\nstatus: old\n---\n"),
      fm("---\ntype: meeting\nstatus: [old, new]\n---\n"),
    );
    expect(d[0]?.values).toEqual(["new"]);
    expect(d[0]?.message).toContain("v59");
  });

  it("a tag differing only in case from a pre-existing bad tag adds nothing", () => {
    const eff = effectiveOf(
      `---\nconventions:\n  frontmatter:\n    values:\n      tags: [bar]\n    severity: {tags: block, "*": warn}\n---\n# rules\n`,
    );
    const d = blockingDelta(
      eff,
      "n.md",
      fm("---\ntags: [Foo]\n---\n"),
      fm("---\ntags: [foo]\n---\n"),
    );
    expect(d).toEqual([]);
  });

  const sevEff = (values: string, severity: string) =>
    effectiveOf(
      `---\nconventions:\n  frontmatter:\n    values:\n      ${values}\n    severity: ${severity}\n---\n# rules\n`,
    );

  it("severity on tag blocks a tags rule", () => {
    const eff = sevEff("tags: [bar]", "{tag: block}");
    const ws = checkNote(eff, "n.md", fm("---\ntags: [foo]\n---\n"));
    expect(ws.map((w) => [w.property, w.level])).toEqual([["tags", "block"]]);
  });

  it("severity on tags blocks a tag rule", () => {
    const eff = sevEff("tag: [bar]", "{tags: block}");
    const ws = checkNote(eff, "n.md", fm("---\ntag: [foo]\n---\n"));
    expect(ws.map((w) => [w.property, w.level])).toEqual([["tag", "block"]]);
  });

  it("a severity-only type entry does not change judging", () => {
    const plain = effectiveOf(
      `---\nconventions:\n  frontmatter:\n    severity: {"*": block}\n---\n# rules\n`,
    );
    const withType = effectiveOf(
      `---\nconventions:\n  frontmatter:\n    severity: {"*": block}\n    types:\n      meeting:\n        severity: {status: block}\n---\n# rules\n`,
    );
    const note = fm("---\ntype: [meeting, research]\n---\n");
    expect(checkNote(plain, "n.md", note)).toEqual([]);
    expect(checkNote(withType, "n.md", note)).toEqual(checkNote(plain, "n.md", note));
  });
});
