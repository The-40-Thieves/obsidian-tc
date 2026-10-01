// Source-scan guard: every raw capture_queue read reachable from a tool handler goes through the
// read-ACL helpers (tools/m5/capture-read-acl.ts). `listCaptures` / `getCapture` return a row's
// content and the note path it names no matter who is asking, so a handler that reads from them
// directly is an existence and content oracle for notes the caller's read ACL hides. The behaviour
// is pinned by m5-capture-read-acl.test.ts; this only pins WHERE the raw reads live.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");
const RAW_READ = /\b(listCaptures|getCapture)\(/g;
const RAW_SQL = /\bcapture_queue\b/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? sourceFiles(join(dir, d.name))
      : d.name.endsWith(".ts")
        ? [join(dir, d.name)]
        : [],
  );
}

function code(file: string): string {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
}

function scan(re: RegExp): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of sourceFiles(SRC)) {
    const rel = relative(SRC, f).split("\\").join("/");
    if (rel === "capture/queue.ts" || rel === "db/migrations-embedded.ts") continue;
    const n = [...code(f).matchAll(re)].length;
    if (n > 0) out.set(rel, n);
  }
  return out;
}

describe("raw capture_queue reads are accounted for", () => {
  const reads = scan(RAW_READ);

  it("floor: the scan sees the helper's raw reads (it is not scanning nothing)", () => {
    expect(reads.size).toBeGreaterThanOrEqual(1);
    expect(reads.get("tools/m5/capture-read-acl.ts") ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("only the read-ACL helper calls listCaptures / getCapture outside capture/queue.ts", () => {
    expect(Object.fromEntries(reads)).toEqual({ "tools/m5/capture-read-acl.ts": 2 });
  });

  it("no tool handler queries capture_queue directly except the registry's committed-row maintenance counts", () => {
    const direct = [...scan(RAW_SQL).keys()].filter((f) => f.startsWith("tools/"));
    expect(direct.sort()).toEqual(["tools/m1/registry-tools.ts"]);
  });

  it("the capture tool handlers read through the helpers", () => {
    const src = code(join(SRC, "tools/m5/capture-tools.ts"));
    expect(src).toMatch(/listReadableCaptures\(/);
    expect(src).toMatch(/getReadableCapture\(/);
    expect(src).not.toMatch(RAW_READ);
  });

  it("the helper gates on both paths a capture can name, via the shared read predicate", () => {
    const src = code(join(SRC, "tools/m5/capture-read-acl.ts"));
    expect(src).toMatch(/readableRel\(/);
    expect(src).toMatch(/committed_path/);
    expect(src).toMatch(/target_path_hint/);
    expect(src).toMatch(/readEnumerationUnrestricted\(/);
  });
});
