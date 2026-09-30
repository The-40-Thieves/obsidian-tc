// Structural, per-key view of the published config JSON Schema.
//
// This replaces a single pinned SHA-256 of the emitted bytes. The hash was a second witness that an
// unintended CHANGE could not hide behind regenerating the schema file, but one literal shared by
// every config PR made any two of them conflict, and its only signal was "something differs" — a
// reworded description tripped it exactly like a changed default. The same guarantee, stated per
// key: compare the schema against the same file on the base branch and demand that every key whose
// TYPE, DEFAULT or CONSTRAINT moved (or that vanished) is named by the change's release-note
// fragment (`config-schema-change:`). Adding a key, and rewording a description, need no ceremony.
const PROSE_KEYS = new Set(["description", "title", "$comment", "examples", "deprecated"]);
const CHILD_KEYS = new Set([
  "properties",
  "items",
  "anyOf",
  "oneOf",
  "allOf",
  "additionalProperties",
  "required",
]);

/** Flatten a JSON Schema into `path -> structural signature` (everything but prose and children). */
export function flattenSchema(schema) {
  const out = new Map();
  const walk = (node, path, required) => {
    if (node === null || typeof node !== "object") return;
    const sig = {};
    for (const [k, v] of Object.entries(node)) {
      if (PROSE_KEYS.has(k) || CHILD_KEYS.has(k)) continue;
      sig[k] = v;
    }
    if (required !== undefined) sig.__required = required;
    out.set(path || "$", JSON.stringify(sig, Object.keys(sig).sort()));
    const req = new Set(Array.isArray(node.required) ? node.required : []);
    for (const [name, child] of Object.entries(node.properties ?? {})) {
      walk(child, path ? `${path}.${name}` : name, req.has(name));
    }
    if (node.items && typeof node.items === "object") walk(node.items, `${path}[]`);
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      for (const [i, child] of (node[key] ?? []).entries()) walk(child, `${path}|${key}${i}`);
    }
    if (node.additionalProperties && typeof node.additionalProperties === "object") {
      walk(node.additionalProperties, `${path}{}`);
    }
  };
  walk(schema, "", undefined);
  return out;
}

/** What moved between two flattened schemas. */
export function diffStructure(base, head) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [path, sig] of head) {
    if (!base.has(path)) added.push(path);
    else if (base.get(path) !== sig) changed.push({ path, before: base.get(path), after: sig });
  }
  for (const path of base.keys()) if (!head.has(path)) removed.push(path);
  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
}

/** The user-facing key a structural path belongs to: `a.b[]|anyOf0.c` -> `a.b.c` is not needed; the
 *  acknowledgement names the dotted property path, so strip the structural suffixes for matching. */
function keyOf(path) {
  return path.replace(/\[\]|\{\}|\|(?:anyOf|oneOf|allOf)\d+/g, "");
}

/**
 * Paths whose change is NOT covered by the acknowledged key list. A key is covered by naming it or
 * any ancestor (`retrieval` covers `retrieval.cache.ttl`). `added` never needs acknowledging.
 */
export function unacknowledged(diff, acknowledged) {
  const acked = acknowledged.map((a) => a.trim()).filter(Boolean);
  const covered = (path) => {
    const key = keyOf(path);
    return acked.some((a) => key === a || key.startsWith(`${a}.`));
  };
  return [
    ...diff.removed.map((path) => ({ path, kind: "removed" })),
    ...diff.changed.map((c) => ({
      path: c.path,
      kind: "changed",
      before: c.before,
      after: c.after,
    })),
  ].filter((p) => !covered(p.path));
}
