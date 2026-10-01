// GH #1027: concise AND detailed payloads against the ADVERTISED JSON output schema, validated the
// way an MCP client validates them: with the SDK's own AjvJsonSchemaValidator over the JSON Schema
// toJson() emits. Zod's safeParse is not enough here: it silently STRIPS unknown keys, while the JSON
// Schema carries `additionalProperties: false` and ajv rejects an unknown key (or a missing required
// one) outright. A concise shape that drops a field the schema still requires, or keeps one it does
// not declare, is invisible to safeParse and fatal to a real client — see health-output-schema.test.ts
// for the incident this pattern came from.
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toJson } from "../src/mcp/facade";
import {
  dataOf,
  makeWorld,
  registryOf,
  runScenario,
  SCENARIOS,
  type World,
} from "./response-format-fixture";

// Every case builds fresh vaults through the real registry; under load that outgrows the 5 s default.
vi.setConfig({ testTimeout: 60_000 });

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.cleanup();
});

async function validateAgainstAdvertised(
  scenarioName: string,
  extra: Record<string, unknown>,
): Promise<{ valid: boolean; errorMessage?: string }> {
  const s = SCENARIOS.find((x) => x.name === scenarioName);
  if (!s) throw new Error(`no scenario ${scenarioName}`);
  const w = await makeWorld();
  worlds.push(w);
  const data = dataOf(await runScenario(w, s, extra));
  const def = (await registryOf(w, s)).list().find((t) => t.name === s.tool);
  if (!def?.outputSchema) throw new Error(`${s.tool} advertises no outputSchema`);
  // The zod path too: strict-mode dispatch already parsed it, but say so explicitly.
  expect(def.outputSchema.safeParse(data).success, `${s.name} zod`).toBe(true);
  const validate = new AjvJsonSchemaValidator().getValidator(toJson(def.outputSchema) as never);
  return validate(JSON.parse(JSON.stringify(data)));
}

describe("advertised output schema accepts both formats (SDK ajv path)", () => {
  for (const s of SCENARIOS) {
    for (const format of ["detailed", "concise"] as const) {
      it(`${s.name} [${format}]`, async () => {
        const r = await validateAgainstAdvertised(s.name, { response_format: format });
        expect(r.valid, r.errorMessage).toBe(true);
      });
    }
    it(`${s.name} [no parameter]`, async () => {
      const r = await validateAgainstAdvertised(s.name, {});
      expect(r.valid, r.errorMessage).toBe(true);
    });
  }
});

describe("the validator is actually strict (negative controls)", () => {
  async function validator(tool: string, scenarioName: string) {
    const w = await makeWorld();
    worlds.push(w);
    const s = SCENARIOS.find((x) => x.name === scenarioName);
    if (!s) throw new Error(scenarioName);
    const def = (await registryOf(w, s)).list().find((t) => t.name === tool);
    // biome-ignore lint/style/noNonNullAssertion: every tool under test advertises an outputSchema
    return new AjvJsonSchemaValidator().getValidator(toJson(def!.outputSchema!) as never);
  }

  it("rejects an undeclared key on a concise write ack", async () => {
    const v = await validator("write_note", "write_note (create)");
    const ok = { vault: "test", path: "x.md", content_hash: "h" };
    expect(v(ok).valid).toBe(true);
    expect(v({ ...ok, surprise: 1 }).valid).toBe(false);
  });

  it("rejects a write ack missing the always-required fields", async () => {
    const v = await validator("patch_note", "patch_note (append)");
    expect(v({ vault: "test", path: "x.md" }).valid).toBe(false);
    expect(v({ vault: "test", content_hash: "h" }).valid).toBe(false);
  });

  it("rejects a concise read_note that carries neither body nor section nor hash", async () => {
    const v = await validator("read_note", "read_note");
    expect(v({ vault: "test", path: "a.md" }).valid).toBe(false);
    expect(v({ vault: "test", path: "a.md", content_hash: "h", body: "x" }).valid).toBe(true);
  });
});
