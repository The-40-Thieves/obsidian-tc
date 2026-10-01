// Source-scan guard: every raw capture_queue read reachable from a tool handler goes through the
// read-ACL helpers (tools/m5/capture-read-acl.ts). `listCaptures` / `getCapture` return a row's
// content and the note path it names no matter who is asking, so a handler that reads from them
// directly is an existence and content oracle for notes the caller's read ACL hides. The behaviour
// is pinned by m5-capture-read-acl.test.ts and m5-read-acl-parity.test.ts; this only pins WHERE the
// raw reads live.
//
// The scan is structural (ast-grep, ast-source-scan.ts), not a line regex. The first version was a
// regex over `listCaptures(` / `getCapture(`, and the cross-vendor review of #1085 pointed out what
// it cannot see: an import alias (`getCapture as rawGet`), a namespace call (`q.getCapture(...)`),
// `listCaptureTags`, and SQL written anywhere under src/ rather than only under tools/. Each of
// those is now a fixture below that must be caught.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  aliasEscapeRules,
  countByRuleAndFile,
  type SourceHit,
  scanSource,
} from "./ast-source-scan";
import { makeTempDir, rmTemp } from "./tmp";

const SRC = join(import.meta.dirname, "..", "src");
const RAW = "listCaptures|getCapture|listCaptureTags";

const RULES = `id: raw-import
language: ts
rule:
  all:
    - kind: import_specifier
    - has:
        field: name
        regex: '^(${RAW})$'
---
id: raw-reexport
language: ts
rule:
  all:
    - kind: export_specifier
    - has:
        field: name
        regex: '^(${RAW})$'
---
id: queue-sql
language: ts
rule:
  kind: string_fragment
  regex: 'capture_queue'
---
${aliasEscapeRules("escape", RAW, "capture/queue")}`;

// The module that defines the raw reads, and the generated embedded migration SQL.
const EXCLUDED = ["capture/queue.ts", "db/migrations-embedded.ts"];
const scan = (dir: string) => countByRuleAndFile(scanSource(dir, RULES), EXCLUDED);

describe("raw capture_queue reads are accounted for", () => {
  const found = scan(SRC);

  it("floor: the scan sees the helper's raw reads and the known SQL strings (it is not scanning nothing)", () => {
    expect(found["raw-import"]?.["tools/m5/capture-read-acl.ts"]).toBeGreaterThanOrEqual(2);
    expect(Object.keys(found["queue-sql"] ?? {}).length).toBeGreaterThanOrEqual(5);
  });

  it("only the read-ACL helper imports listCaptures / getCapture; listCaptureTags only for the importers' own dedupe", () => {
    expect(found["raw-import"]).toEqual({
      // The two CLI importers read their OWN source's tags column for re-sync dedupe: no tool
      // handler reaches them, and they return tag lists only.
      "capture/ambient-import.ts": 1,
      "capture/highlight-import.ts": 1,
      "tools/m5/capture-read-acl.ts": 2,
    });
    expect(found["raw-reexport"]).toBeUndefined();
  });

  it("nothing reaches the raw reads by alias, namespace, re-export, member call or dynamic load", () => {
    for (const rule of [
      "escape-alias",
      "escape-namespace",
      "escape-star-export",
      "escape-member-call",
      "escape-dynamic-load",
    ])
      expect(found[rule], rule).toBeUndefined();
  });

  it("capture_queue is named only where it is accounted for, anywhere under src/", () => {
    expect(found["queue-sql"]).toEqual({
      "cli/commands/doctor-probes.ts": 1, // a table-name label, no query
      "cli/usage.ts": 1, // help text
      "db/maintenance.ts": 2, // retention sweep: DELETE of committed rows, reads no content
      "db/migration-manifest.ts": 1, // a migration file name
      "metrics/gauge-sources.ts": 1, // COUNT(*) queue depth: the /metrics cross-vault depth, tracked apart from this guard
      "metrics/registry.ts": 2, // metric help text
      "tools/m1/registry-tools.ts": 3, // reset_vault_cache's committed-row count + delete (admin) and its description
      "tools/m5/capture-tools.ts": 1, // description text
      "vault/identity.ts": 1, // a table-name list
    });
  });

  it("the capture tool handlers read through the helpers", () => {
    const src = readFileSync(join(SRC, "tools/m5/capture-tools.ts"), "utf8");
    expect(src).toMatch(/listReadableCaptures\(/);
    expect(src).toMatch(/getReadableCapture\(/);
  });

  it("the helper decides with read_note's predicate on the bound root, with no lexical shortcut", () => {
    const src = readFileSync(join(SRC, "tools/m5/capture-read-acl.ts"), "utf8");
    expect(src).toMatch(/callerCanReadVaultPath\(/);
    expect(src).toMatch(/committed_path/);
    expect(src).toMatch(/target_path_hint/);
    expect(src).not.toMatch(/\breadableRel\(|normalizeVaultPath\(/);
  });
});

describe("the guard catches the shapes a line regex missed (RED fixtures)", () => {
  let dir: string;
  let hits: SourceHit[];
  beforeAll(() => {
    dir = makeTempDir("capture-guard-");
    mkdirSync(join(dir, "tools"), { recursive: true });
    const w = (name: string, body: string) => writeFileSync(join(dir, "tools", name), body);
    w("alias.ts", 'import { getCapture as rawGet } from "../capture/queue";\nrawGet(db, "id");\n');
    w("ns.ts", 'import * as q from "../capture/queue";\nq.listCaptures(db, "v");\n');
    w(
      "tags.ts",
      'import { listCaptureTags } from "../capture/queue";\nlistCaptureTags(db, "v", "s");\n',
    );
    w("reexport.ts", 'export { getCapture } from "../capture/queue";\n');
    w("star.ts", 'export * from "../capture/queue";\n');
    w("dyn.ts", 'const q = await import("../capture/queue");\nq.getCapture(db, "id");\n');
    w("sql.ts", "const rows = db.prepare(`SELECT content FROM capture_queue`).all();\n");
    hits = scanSource(dir, RULES);
  });
  afterAll(() => rmTemp(dir));

  const filesFor = (rule: string) => hits.filter((h) => h.rule === rule).map((h) => h.file);

  it("an aliased import is caught as an import and as an alias", () => {
    expect(filesFor("raw-import")).toContain("tools/alias.ts");
    expect(filesFor("escape-alias")).toContain("tools/alias.ts");
  });
  it("a namespace import and its member call are caught", () => {
    expect(filesFor("escape-namespace")).toContain("tools/ns.ts");
    expect(filesFor("escape-member-call")).toContain("tools/ns.ts");
  });
  it("listCaptureTags is tracked", () => {
    expect(filesFor("raw-import")).toContain("tools/tags.ts");
  });
  it("a re-export, an export-star and a dynamic load are caught", () => {
    expect(filesFor("raw-reexport")).toContain("tools/reexport.ts");
    expect(filesFor("escape-star-export")).toContain("tools/star.ts");
    expect(filesFor("escape-dynamic-load")).toContain("tools/dyn.ts");
  });
  it("capture_queue SQL in a template string is caught", () => {
    expect(filesFor("queue-sql")).toContain("tools/sql.ts");
  });
});
