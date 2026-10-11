// Directory listings (the ChatGPT app directory, Claude's connector review) require every tool to
// carry `readOnlyHint`, `destructiveHint` and `openWorldHint` as explicit booleans, because the MCP
// spec's defaults (`readOnlyHint: false`, `destructiveHint: true`, `openWorldHint: true`) read as
// "destructive, open-world" when a hint is merely absent. Source: developers.openai.com/plugins/
// plugin-guidelines ("Set `readOnlyHint`, `destructiveHint`, and `openWorldHint` to explicit boolean
// values"), fetched 2026-10-10.
//
// What is audited is the WIRE: tools/list through a real server, for the surface a directory
// reviewer actually sees (`/mcp/core`: flat mode, core subset), plus every other advertised surface
// so a tool cannot dodge the check by living in the triad or a domain tool.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import { FolderAcl } from "../src/acl";
import type { CallerContext } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { type AdvertiseSubset, NON_CORE_TOOL_NAMES } from "../src/mcp/tool-profiles";

const HINTS = ["readOnlyHint", "destructiveHint", "openWorldHint"] as const;

const context = (): CallerContext => ({
  caller: "stdio",
  authenticated: true,
  grantedScopes: new Set(["*"]),
  vaultId: "v1",
  db: {} as never,
  acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
});

async function wireTools(opts: {
  facadeMode: "triad" | "domain" | "flat";
  advertise?: AdvertiseSubset;
}): Promise<Tool[]> {
  const server = createMcpServer({
    name: "x",
    version: "0",
    registry: buildFullRegistry(),
    context,
    visibility: { grantedScopes: new Set(["*"]) },
    ...opts,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  await client.close();
  return tools;
}

/** The hints a tool does NOT state as an own boolean — `[]` means fully explicit. */
function missingHints(t: Tool): string[] {
  const a = (t.annotations ?? {}) as Record<string, unknown>;
  return HINTS.filter((h) => typeof a[h] !== "boolean");
}

function offenders(tools: Tool[]): string[] {
  return tools.flatMap((t) => {
    const missing = missingHints(t);
    return missing.length ? [`${t.name}: missing ${missing.join(", ")}`] : [];
  });
}

describe("explicit annotations on every advertised tool", () => {
  it("core profile (flat, advertise: core) states all three hints on every tool", async () => {
    const tools = await wireTools({ facadeMode: "flat", advertise: "core" });
    // existence floor: an empty or tiny listing must not read as a pass
    expect(tools.length).toBeGreaterThanOrEqual(90);
    expect(offenders(tools)).toEqual([]);
  });

  it("the core listing holds no tool the profile hides, and no generic executor of the facade", async () => {
    const names = new Set(
      (await wireTools({ facadeMode: "flat", advertise: "core" })).map((t) => t.name),
    );
    for (const hidden of NON_CORE_TOOL_NAMES) expect(names.has(hidden), hidden).toBe(false);
    for (const executor of [
      "find_capability",
      "describe_capability",
      "call_capability",
      "execute_command",
      "execute_template",
      "eval_dataview_field",
    ])
      expect(names.has(executor), executor).toBe(false);
  });

  it("every other surface states all three hints too (flat all, domain, triad)", async () => {
    for (const opts of [
      { facadeMode: "flat" as const, advertise: "all" as const },
      { facadeMode: "flat" as const, advertise: "essentials" as const },
      { facadeMode: "domain" as const },
      { facadeMode: "triad" as const },
    ]) {
      const tools = await wireTools(opts);
      expect(tools.length, JSON.stringify(opts)).toBeGreaterThanOrEqual(3);
      expect(offenders(tools), JSON.stringify(opts)).toEqual([]);
    }
  });

  it("hints never contradict: a read-only tool is not destructive", async () => {
    const tools = await wireTools({ facadeMode: "flat", advertise: "core" });
    const bad = tools.filter(
      (t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === true,
    );
    expect(bad.map((t) => t.name)).toEqual([]);
  });

  it("the checker itself rejects an absent hint (watch-it-fail guard)", () => {
    const t = {
      name: "x",
      inputSchema: { type: "object" },
      annotations: { openWorldHint: false },
    } as Tool;
    expect(offenders([t])).toEqual(["x: missing readOnlyHint, destructiveHint"]);
    expect(offenders([{ ...t, annotations: undefined } as Tool])).toEqual([
      "x: missing readOnlyHint, destructiveHint, openWorldHint",
    ]);
  });
});
