import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { diffStructure, flattenSchema, unacknowledged } from "./lib/config-schema-structure.mjs";

const real = () =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "docs", "obsidian-tc.config.schema.json"), "utf8"),
  );

/** First leaf property (path, node) under the real schema that carries a numeric/boolean default. */
function firstDefaulted(schema, prefix = "") {
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (child.default !== undefined && typeof child.default !== "object")
      return { path, node: child };
    const deeper = firstDefaulted(child, path);
    if (deeper) return deeper;
  }
  return null;
}

test("the real schema flattens to a healthy number of nodes (existence floor)", () => {
  assert.ok(flattenSchema(real()).size > 300);
});

test("an identical schema has an empty diff, and a description rewrite is not a structural change", () => {
  const a = real();
  const b = structuredClone(a);
  const { node } = firstDefaulted(b);
  node.description = "rewritten prose that changes nothing structural";
  const d = diffStructure(flattenSchema(a), flattenSchema(b));
  assert.deepEqual(d, { added: [], removed: [], changed: [] });
});

test("an added key is reported but needs no acknowledgement", () => {
  const a = real();
  const b = structuredClone(a);
  b.properties.brandNewBlock = {
    type: "object",
    properties: { flag: { type: "boolean", default: false } },
  };
  const d = diffStructure(flattenSchema(a), flattenSchema(b));
  assert.deepEqual(d.added, ["brandNewBlock", "brandNewBlock.flag"]);
  assert.deepEqual(unacknowledged(d, []), []);
});

test("RED: an unintended default change on an existing key fails until the change names that key", () => {
  const a = real();
  const b = structuredClone(a);
  const { path, node } = firstDefaulted(b);
  const target = path.split(".").reduce((n, k) => n.properties[k], b);
  assert.equal(target, node);
  node.default = typeof node.default === "boolean" ? !node.default : node.default + 1;
  const d = diffStructure(flattenSchema(a), flattenSchema(b));
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].path, path);
  assert.deepEqual(
    unacknowledged(d, []).map((x) => x.path),
    [path],
  );
  assert.deepEqual(
    unacknowledged(d, ["some.other.key"]).map((x) => x.path),
    [path],
  );
  assert.deepEqual(unacknowledged(d, [path]), []);
  // naming an ancestor block covers everything beneath it
  const top = path.split(".")[0];
  assert.deepEqual(unacknowledged(d, [top]), []);
  // ...but a sibling prefix that merely shares leading characters does not
  assert.notDeepEqual(unacknowledged(d, [`${top.slice(0, -1)}`]), []);
});

test("RED: removing a key, changing a type, or tightening a constraint each fail", () => {
  const a = real();
  const removedB = structuredClone(a);
  const name = Object.keys(removedB.properties)[0];
  delete removedB.properties[name];
  assert.ok(
    unacknowledged(diffStructure(flattenSchema(a), flattenSchema(removedB)), []).some(
      (x) => x.kind === "removed",
    ),
  );

  const { path } = firstDefaulted(a);
  const retyped = structuredClone(a);
  const n = path.split(".").reduce((x, k) => x.properties[k], retyped);
  n.type = n.type === "string" ? "number" : "string";
  assert.equal(
    unacknowledged(diffStructure(flattenSchema(a), flattenSchema(retyped)), []).length,
    1,
  );

  const constrained = structuredClone(a);
  const c = path.split(".").reduce((x, k) => x.properties[k], constrained);
  c.minimum = 7;
  assert.equal(
    unacknowledged(diffStructure(flattenSchema(a), flattenSchema(constrained)), []).length,
    1,
  );
});

test("a key becoming required is a structural change on that key", () => {
  const a = real();
  const b = structuredClone(a);
  const top = Object.keys(b.properties)[0];
  b.required = [...(b.required ?? []), top];
  const d = diffStructure(flattenSchema(a), flattenSchema(b));
  assert.deepEqual(
    d.changed.map((c) => c.path),
    [top],
  );
});
