// Shared by the source-scan guards that pin WHERE a raw read lives (m5-capture-lookup-guard,
// m5-memory-lookup-guard). A regex over source lines is evaded by an import alias
// (`getCapture as rawGet`), a namespace import, a re-export or a computed load; ast-grep (the
// repo's pinned parser, scripts/ast-grep-bin.mjs) finds each by its role in the syntax tree.
import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { astGrep } from "../../../scripts/ast-grep-bin.mjs";
import { stallTimeout } from "./stall-timeouts";

export interface SourceHit {
  rule: string;
  /** Path relative to the scanned directory, forward-slashed. */
  file: string;
  line: number;
  text: string;
}

/** Run every rule in `rulesYaml` (multi-document, `---` separated) over `dir`. */
export function scanSource(dir: string, rulesYaml: string): SourceHit[] {
  const bin = astGrep();
  const out = execFileSync(
    bin.cmd,
    [...bin.prefix, "scan", "--inline-rules", rulesYaml, "--json=compact", dir],
    {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: stallTimeout(60_000),
    },
  );
  if (!out.trim()) return [];
  const raw = JSON.parse(out) as Array<{
    ruleId: string;
    file: string;
    text: string;
    range: { start: { line: number } };
  }>;
  return raw.map((m) => ({
    rule: m.ruleId,
    file: relative(resolve(dir), resolve(dir, m.file)).split("\\").join("/"),
    line: m.range.start.line + 1,
    text: m.text,
  }));
}

/** `rule -> file -> count`, skipping `exclude`d files. */
export function countByRuleAndFile(
  hits: readonly SourceHit[],
  exclude: readonly string[],
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const h of hits) {
    if (exclude.includes(h.file)) continue;
    const byFile = out[h.rule] ?? {};
    byFile[h.file] = (byFile[h.file] ?? 0) + 1;
    out[h.rule] = byFile;
  }
  return out;
}

/** Rules that catch every way of reaching `names` exported by a module whose path contains
 *  `modulePath`, other than a plain call of the imported name: an aliased import or re-export,
 *  a namespace import or `export *`, a member call (`ns.name(...)`), and a dynamic load. `prefix`
 *  starts each rule id. */
export function aliasEscapeRules(prefix: string, names: string, modulePath: string): string {
  return String.raw`id: ${prefix}-alias
language: ts
rule:
  all:
    - any:
        - kind: import_specifier
        - kind: export_specifier
    - has:
        field: name
        regex: '^(${names})$'
    - has:
        field: alias
        regex: '.'
---
id: ${prefix}-namespace
language: ts
rule:
  kind: namespace_import
  inside:
    stopBy: end
    kind: import_statement
    has:
      field: source
      regex: '${modulePath}'
---
id: ${prefix}-star-export
language: ts
rule:
  kind: export_statement
  regex: '^export\s*\*'
  has:
    field: source
    regex: '${modulePath}'
---
id: ${prefix}-member-call
language: ts
rule:
  kind: member_expression
  has:
    field: property
    regex: '^(${names})$'
---
id: ${prefix}-dynamic-load
language: ts
rule:
  any:
    - pattern: import($V)
    - pattern: require($V)
constraints:
  V:
    regex: '${modulePath}'
`;
}
