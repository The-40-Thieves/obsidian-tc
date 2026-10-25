import { afterEach, describe, expect, it } from "vitest";
import type { CallerContext } from "../src/mcp/registry";
import { type M4Vault, makeM4Vault } from "./m4-helpers";

interface MalformedEffectCase {
  tool: string;
  route: string;
  input: Record<string, unknown>;
  installed?: string[];
  files?: Record<string, string>;
  confirmed?: boolean;
  commandPolicy?: () => { enabled: boolean; allowlist: string[] };
}

const CASES: MalformedEffectCase[] = [
  {
    tool: "execute_command",
    route: "POST /obsidian-tc/v1/commands/execute",
    input: { command_id: "editor:save-file" },
    confirmed: true,
    commandPolicy: () => ({ enabled: true, allowlist: ["editor:save-file"] }),
  },
  {
    tool: "git_stage",
    route: "POST /obsidian-tc/v1/git/stage",
    input: { paths: ["pages/open.md"] },
    installed: ["git"],
    files: { "pages/open.md": "open" },
  },
  {
    tool: "git_commit",
    route: "POST /obsidian-tc/v1/git/commit",
    input: { message: "snapshot" },
    installed: ["git"],
    confirmed: true,
  },
  {
    tool: "execute_template",
    route: "POST /obsidian-tc/v1/templater/execute",
    input: { template: "Templates/daily.md", target: "Daily/new.md" },
    installed: ["templater"],
    files: { "Templates/daily.md": "template" },
    confirmed: true,
  },
  {
    tool: "trigger_quickadd",
    route: "POST /obsidian-tc/v1/quickadd/trigger",
    input: { action_name: "Capture" },
    installed: ["quickadd"],
    confirmed: true,
  },
  {
    tool: "remotely_save_trigger",
    route: "POST /obsidian-tc/v1/remotely-save/trigger",
    input: {},
    installed: ["remotely-save"],
  },
  {
    tool: "create_excalidraw",
    route: "POST /obsidian-tc/v1/excalidraw/write",
    input: { path: "Drawings/new.excalidraw" },
    installed: ["excalidraw"],
  },
  {
    tool: "update_excalidraw",
    route: "POST /obsidian-tc/v1/excalidraw/write",
    input: { path: "Drawings/open.excalidraw", add_elements: [] },
    installed: ["excalidraw"],
    files: { "Drawings/open.excalidraw": "{}" },
  },
];

describe.each(CASES)("$tool malformed post-effect acknowledgement", (testCase) => {
  let v: M4Vault | undefined;
  afterEach(() => v?.cleanup());

  it("marks the effect committed and returns a non-retryable bridge-shape error", async () => {
    v = makeM4Vault({
      installed: testCase.installed,
      files: testCase.files,
      commandPolicy: testCase.commandPolicy,
      routes: { [testCase.route]: { body: { ok: true, result: {} } } },
    });
    let marked = 0;
    // A confirmed call gets its marker from dispatch, which refuses a context that already carries
    // one: its commit is observed through the token row instead of a preset spy.
    const context: Partial<CallerContext> = testCase.confirmed
      ? {}
      : { markEffectCommitted: () => marked++ };
    const input = { vault: "test", ...testCase.input };

    const result = testCase.confirmed
      ? await v.callConfirmed(testCase.tool, input, context)
      : await v.call(testCase.tool, input, context);

    expect(result.ok ? undefined : result.error).toMatchObject({
      code: "plugin_incompatible",
      retryable: false,
      message: expect.stringMatching(/action may already have taken effect/i),
      details: { effect_committed: true },
    });
    if (testCase.confirmed) {
      const unspent = v.db
        .prepare("SELECT COUNT(*) AS n FROM elicit_tokens WHERE consumed_at IS NULL")
        .get() as { n: number };
      expect(unspent.n).toBe(0);
    } else {
      expect(marked).toBe(1);
    }
    expect(v.bridgeRequests).toHaveLength(1);
  });
});
