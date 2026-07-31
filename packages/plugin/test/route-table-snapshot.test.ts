// WP6.1 invariant, pinned BEFORE the routes.ts split it protects (routes.ts:953 lines, 15
// integration families, 28 route paths). This is deliberately an INLINE LITERAL, not
// `toMatchSnapshot()` — packages/plugin/test had no `__snapshots__` dir, so a `toMatchSnapshot()`
// here would auto-write-and-pass on first run and assert nothing. That exact mistake already cost
// this refactor program time in WP2.
//
// Two properties matter, and both must survive every extraction slice with zero diff:
//   - ORDER: the server's bridge client has no opinion on route order today, but `buildRoutes`
//     concatenates per-family builders in a fixed sequence (map's WP6 requirement), and an
//     unnoticed reorder during extraction is exactly the kind of change a `toContainEqual`-style
//     assertion would miss. Exact array equality catches it.
//   - UNIQUENESS: two families landing on the same (method, path) would have one silently shadow
//     the other wherever routes get registered by iteration; asserted explicitly, not just implied
//     by the length check.
import { describe, expect, it } from "vitest";
import { buildRoutes } from "../src/routes";

function fakeApp() {
  return {
    commands: { listCommands: () => [], executeCommandById: () => true },
    plugins: { plugins: {} },
    internalPlugins: { plugins: {} },
    vault: {
      getAbstractFileByPath: () => null,
      getName: () => "TestVault",
      adapter: { getBasePath: () => "/tmp/TestVault" },
    },
  } as never;
}

// The full ordered route table as of WP6.1, one entry per (method, path) in the exact order
// `buildRoutes` emits them: probe, commands, git, remotely-save, dataview, quickadd, ocr,
// excalidraw, makemd, omnisearch, datacore, metadata-menu, daily-notes, templater, tasks.
const EXPECTED_ROUTE_TABLE = [
  "get /probe",
  "post /commands/list",
  "post /commands/execute",
  "post /git/status",
  "post /git/diff",
  "post /git/log",
  "post /git/stage",
  "post /git/commit",
  "post /remotely-save/status",
  "post /remotely-save/trigger",
  "post /dataview/dql",
  "post /dataview/validate",
  "post /dataview/eval",
  "post /quickadd/actions",
  "post /quickadd/trigger",
  "post /ocr/attachment",
  "post /ocr/bulk",
  "post /excalidraw/read",
  "post /excalidraw/write",
  "post /makemd/spaces",
  "post /makemd/query",
  "post /omnisearch/search",
  "post /datacore/query",
  "post /metadata-menu/fields",
  "post /daily-notes/resolve",
  "post /templater/list",
  "post /templater/execute",
  "post /tasks/filter",
];

describe("buildRoutes — full route-table snapshot (method, path, order, uniqueness)", () => {
  it("emits exactly the pinned 28 routes, in the pinned order", () => {
    const actual = buildRoutes(fakeApp(), "1.13.1", []).map((d) => `${d.method} ${d.path}`);
    expect(actual).toEqual(EXPECTED_ROUTE_TABLE);
  });

  it("has no duplicate (method, path) pair", () => {
    const actual = buildRoutes(fakeApp(), "1.13.1", []).map((d) => `${d.method} ${d.path}`);
    expect(new Set(actual).size).toBe(actual.length);
    expect(actual.length).toBe(EXPECTED_ROUTE_TABLE.length);
  });
});
