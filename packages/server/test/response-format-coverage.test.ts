// GH #1027: every registered tool is response_format-aware, on the documented exempt list, or on the
// explicit not-yet-covered list. A tool added without that decision fails here and says which list
// it belongs on. The registry is the real composition root's, so the check sees what ships.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { configFromVaultPath } from "../src/cli/args";
import { buildServerRuntime } from "../src/runtime/server-runtime";
import { REGISTERED_TOOL_NAMES } from "./registered-tool-count";
import {
  EXEMPT_FROM_RESPONSE_FORMAT,
  NOT_YET_COVERED_BY_RESPONSE_FORMAT,
} from "./response-format-coverage";
import { topLevelShape } from "./schema-introspect";
import { makeTempDir, rmTemp } from "./tmp";

vi.setConfig({ testTimeout: 60_000 });

const dirs: string[] = [];
let all: string[] = [];
let aware: string[] = [];
let closeRuntime: (() => Promise<void>) | undefined;

// One runtime for the file: building the whole registry is the slow part.
beforeAll(async () => {
  const vaultDir = makeTempDir("otc-rfcov-vault-");
  const cacheDir = makeTempDir("otc-rfcov-cache-");
  dirs.push(vaultDir, cacheDir);
  writeFileSync(join(vaultDir, "n.md"), "# N\n");
  const config = configFromVaultPath(vaultDir);
  config.cacheDir = cacheDir;
  const runtime = await buildServerRuntime(config, join(vaultDir, "config.json"));
  closeRuntime = () => runtime.close("test cleanup");
  const defs = runtime.registry.list();
  all = defs.map((d) => d.name);
  aware = defs
    .filter((d) => "response_format" in (topLevelShape(d.inputSchema) ?? {}))
    .map((d) => d.name);
});
afterAll(async () => {
  await closeRuntime?.();
  for (const d of dirs.splice(0)) rmTemp(d);
});

describe("response_format coverage: every tool made the decision", () => {
  it("registers the same tool names as registered-tools.txt (the registry under test is the whole surface)", async () => {
    expect([...all].sort()).toEqual([...REGISTERED_TOOL_NAMES].sort());
  });

  it("every registered tool is aware, exempt, or not-yet-covered, and exactly one", async () => {
    const exempt = new Set(Object.keys(EXEMPT_FROM_RESPONSE_FORMAT));
    const todo = new Set(NOT_YET_COVERED_BY_RESPONSE_FORMAT);
    const awareSet = new Set(aware);
    const undecided = all.filter((n) => !awareSet.has(n) && !exempt.has(n) && !todo.has(n));
    expect(
      undecided,
      "a tool with no response_format decision: add `...ResponseFormatInput` to its input, or list it in EXEMPT_FROM_RESPONSE_FORMAT (with a reason) or NOT_YET_COVERED_BY_RESPONSE_FORMAT in test/response-format-coverage.ts",
    ).toEqual([]);
    const twice = all.filter(
      (n) => Number(awareSet.has(n)) + Number(exempt.has(n)) + Number(todo.has(n)) > 1,
    );
    expect(twice, "a tool on more than one list").toEqual([]);
  });

  it("neither list names a tool that is not registered (a renamed or removed tool cannot linger)", async () => {
    const registered = new Set(all);
    expect(Object.keys(EXEMPT_FROM_RESPONSE_FORMAT).filter((n) => !registered.has(n))).toEqual([]);
    expect(NOT_YET_COVERED_BY_RESPONSE_FORMAT.filter((n) => !registered.has(n))).toEqual([]);
    expect(new Set(NOT_YET_COVERED_BY_RESPONSE_FORMAT).size).toBe(
      NOT_YET_COVERED_BY_RESPONSE_FORMAT.length,
    );
  });

  it("an exempt tool does not advertise the parameter, and every exempt entry carries a reason", async () => {
    const awareSet = new Set(aware);
    for (const [name, reason] of Object.entries(EXEMPT_FROM_RESPONSE_FORMAT)) {
      expect(awareSet.has(name), `${name} is exempt but advertises response_format`).toBe(false);
      expect(reason.length, `${name} has no reason`).toBeGreaterThan(10);
    }
  });

  it("the awareness probe has a floor: the tools this series covers are all detected", async () => {
    for (const n of [
      "read_note",
      "write_note",
      "list_notes",
      "search_text",
      "list_attachments",
      "rewrite_link",
      "prune_hub_links",
      "search_and_read",
      "get_entity",
      "work_episodes",
      "gap_report",
    ])
      expect(aware, n).toContain(n);
    expect(aware.length).toBeGreaterThanOrEqual(41);
  });
});
