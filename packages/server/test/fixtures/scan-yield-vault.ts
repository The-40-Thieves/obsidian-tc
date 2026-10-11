// A deterministic vault that exercises every branch of the whole-vault link scans: a directed
// ring (cycles), a hub, orphans (with and without outgoing links), dangling links in the body and
// in a property, code-block / external / heading-only links, a basename shared by two folders, a
// note with bad frontmatter YAML, a wiki folder, and a pseudo-random bulk so ordering and limits
// are non-trivial.

export function scanFixtureFiles(bulk = 300): Record<string, string> {
  const files: Record<string, string> = {};
  const ring = 12;
  for (let i = 0; i < ring; i++)
    files[`ring/r${i}.md`] =
      `---\nsources: [s]\n---\n# R${i}\n[[r${(i + 1) % ring}]] and [[hub]]\n`;
  files["hub.md"] = "# Hub\nno outgoing\n";
  files["orphans/lonely.md"] = "# Lonely\nnothing links here, nothing leaves\n";
  files["orphans/talker.md"] = "# Talker\n[[hub]] only outgoing\n";
  files["dangling.md"] = [
    "---",
    'related: "[[ghost-in-property]]"',
    "---",
    "[[ghost]] [text](missing.md) [ok](hub.md)",
    "```",
    "[[ghost-in-code]]",
    "```",
    "[ext](https://example.com/x) [heading](#h)",
  ].join("\n");
  files["x/dup.md"] = "# dup x\n";
  files["y/dup.md"] = "# dup y\n[[dup]]\n";
  files["bad-yaml.md"] = "---\n: : [\n  - bad\n---\nbody [[hub]] [[ghost-bad-yaml]]\n";
  files["unicode/Ünï-note.md"] = "# Ü\n[[ring/r0]] [[Ünï-note]]\n";
  files["wiki/index.md"] = "# not generated\n[[hub]]\n";
  files["wiki/page.md"] = "---\nsources: [a]\nconfidence: 0.5\nverified: true\n---\n[[hub]]\n";
  let seed = 7;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let i = 0; i < bulk; i++) {
    let body = `---\ntitle: Bulk ${i}\n${i % 3 === 0 ? "sources: [s]\n" : ""}---\n# Bulk ${i}\n`;
    const n = Math.floor(rnd() * 4);
    for (let k = 0; k < n; k++) {
      const pick = Math.floor(rnd() * (bulk + 20));
      body += `see [[bulk/b${pick}]]\n`;
    }
    files[`bulk/f${i % 7}/b${i}.md`] = body;
  }
  return files;
}

/** The calls the differential test compares, as [tool, input] pairs. */
export const SCAN_CALLS: Array<[string, Record<string, unknown>]> = [
  ["vault_health_score", {}],
  ["vault_health_score", { hub_threshold: 2, response_format: "concise" }],
  ["find_orphans", {}],
  ["find_orphans", { require_no_outgoing: true }],
  ["find_orphans", { folder: "orphans" }],
  ["find_orphans", { limit: 5 }],
  ["find_unresolved_links", {}],
  ["find_unresolved_links", { limit: 7 }],
  ["find_unresolved_links", { limit: 5, cursor: "5" }],
  ["find_unresolved_links", { folder: "bulk/f1", response_format: "concise" }],
  ["find_link_cycles", {}],
  ["find_link_cycles", { limit: 3, max_length: 4 }],
  ["find_link_cycles", { limit: 1000, max_length: 1000 }],
  ["get_backlinks", { path: "hub.md" }],
  ["get_backlinks", { path: "ring/r3.md", response_format: "concise" }],
  ["get_backlinks", { path: "hub.md", limit: 4, cursor: "2" }],
  ["audit_provenance", {}],
  ["audit_provenance", { limit: 5, response_format: "concise" }],
  ["get_link_strength", { from: "ring/r0.md", to: "ring/r5.md" }],
  ["suggest_links", { path: "ring/r0.md" }],
];
