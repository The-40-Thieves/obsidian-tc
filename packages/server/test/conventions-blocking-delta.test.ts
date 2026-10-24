// blockingDelta: a write is judged by the blocking violations it ADDS to a note, keyed per value. A new
// note counts all of its blocking violations, a partial fix and an edit that adds nothing return none,
// a second bad value on a property that already had one counts, a broken-YAML before is checkNote(null),
// and a warn-level rule never appears.
import { afterEach, describe, expect, it } from "vitest";
import { blockingDelta } from "../src/conventions/check";
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
});
