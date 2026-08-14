// THE-824: a tool that calls requireConfirmation() demands its elicit token CONDITIONALLY — only
// when the handler's own runtime check decides it's needed (crossing a folder boundary, an
// overwrite, a bulk-cost floor, ...). Before this gate, that fact was invisible on the
// machine-readable surface a programmatic caller actually reads: describe_capability never listed
// `elicit_token` as an input field (mcp/server.ts strips it off rawArgs generically before
// per-tool validation — see tools/call's `if (typeof rawArgs.elicit_token === "string")` — so
// nothing forced a tool's OWN schema to declare it), and every one of these tools advertised
// `destructive: false`. The MCP 2026-07-28 spec's own default for `destructiveHint` is `true`
// ("cautious"; the spec text is explicit that it is meaningful only when `readOnlyHint == false`),
// so a MUTATING tool that can demand confirmation was making a false statement, not a conservative
// one.
//
// Two halves, deliberately different mechanisms:
//   - WHICH tools are conditionally gated is a fact about handler SOURCE (does it call
//     requireConfirmation), not something a runtime registry walk can discover without crafting a
//     request that happens to trip that specific tool's own conditional for every one of ~150 tools
//     — fragile, and it would not catch a 17th call site added without also being added to some
//     hand-kept list here. Source scan instead, mirroring
//     forget-log-reachable-from-tools.test.ts's tsFiles walk + regex derivation.
//   - WHETHER the REGISTERED tool's advertised schema/annotations actually reflect that fact is
//     checked against the real registration recipe (buildFullRegistry(), the same one
//     tool-facade-domain-coverage.test.ts / vault-arg-coverage.test.ts use) and the real
//     describeCapability() function every describe_capability call runs through — so this can never
//     silently drift from what a caller is actually told, the way a hand-maintained expectation
//     here could.
//
// `destructive` is checked only for tools that are actually MUTATING (destructive === true, or a
// required scope in the write/delete/bulk/execute families) — the same predicate
// acl-extraction-coverage.test.ts and vault-arg-coverage.test.ts use, not a second definition of
// "mutating". ocr_bulk is the one conditionally-gated tool that ISN'T mutating: it proxies a
// read-only OCR bridge call and requires confirmation purely as a cost floor, never touches the
// vault, and correctly keeps destructive: false — the spec disclaims destructiveHint's meaning once
// readOnlyHint is true, so flipping it there would trade one false statement for another (a tool
// that "does not modify its environment" AND "may perform destructive updates" is a direct
// self-contradiction, not just unhelpful metadata). It still gets elicit_token, which is unaffected
// by read/write status: the schema is a promise about what the CALL accepts, not about what the
// call does to the vault.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMutatingScope } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import { issueElicitToken } from "../src/elicit";
import { describeCapability } from "../src/mcp/facade";
import { makeTestVault } from "./m1-helpers";
import { topLevelShape } from "./schema-introspect";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const TOOLS_DIR = join(SRC, "tools");

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Every distinct tool name passed as requireConfirmation's 2nd argument anywhere under
 *  src/tools/ — the ground truth for "conditionally HITL-gated", derived from source rather than
 *  hand-kept, so a call site added later is picked up automatically instead of silently joining
 *  the drift this gate exists to catch. */
function conditionallyGatedToolNames(): Set<string> {
  const re = /requireConfirmation\(\s*ctx,\s*"([a-z_]+)"/g;
  const names = new Set<string>();
  for (const file of tsFiles(TOOLS_DIR)) {
    for (const m of readFileSync(file, "utf8").matchAll(re)) names.add(m[1] as string);
  }
  return names;
}

describe("THE-824 conditionally-gated tools advertise elicit_token + an honest destructive hint", () => {
  const gated = conditionallyGatedToolNames();
  const registry = buildFullRegistry();
  const byName = new Map(registry.list().map((d) => [d.name, d]));

  // Non-empty floor (a gate that scans zero files reports success): a regex that stopped matching
  // (a rename of requireConfirmation, a call-shape change) would make every assertion below pass
  // vacuously over an empty set. 16 is the count verified by hand for THE-824's mechanism trace;
  // re-derive rather than bump it if a genuinely new conditionally-gated tool is added.
  it("derives a non-empty, at-least-16 set of conditionally-gated tool names", () => {
    expect(gated.size).toBeGreaterThanOrEqual(16);
  });

  it("every derived name is an actually registered tool", () => {
    const missing = [...gated].filter((n) => !byName.has(n)).sort();
    expect(
      missing,
      `requireConfirmation names a tool that isn't registered: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every conditionally-gated tool declares elicit_token in its input schema", () => {
    const offenders = [...gated]
      .filter((n) => {
        const def = byName.get(n);
        if (!def) return false; // reported by the previous assertion, not this one
        return !("elicit_token" in (topLevelShape(def.inputSchema) ?? {}));
      })
      .sort();
    expect(
      offenders,
      `conditionally-gated tool(s) whose input schema doesn't declare elicit_token, so their ` +
        `confirmation parameter is undiscoverable via describe_capability: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("every MUTATING conditionally-gated tool does not advertise destructive: false", () => {
    const offenders = [...gated]
      .filter((n) => {
        const def = byName.get(n);
        if (!def) return false;
        const mutating = def.destructive === true || def.requiredScopes.some(isMutatingScope);
        if (!mutating) return false; // e.g. ocr_bulk — see module header
        const meta = describeCapability(def) as { annotations: { destructive: boolean } };
        return meta.annotations.destructive === false;
      })
      .sort();
    expect(
      offenders,
      `mutating conditionally-gated tool(s) still advertise destructive: false, contradicting the ` +
        `MCP spec's own default (destructiveHint defaults to true): ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});

describe("THE-824 describe_capability(move_note) reproduces the reported bug's fix", () => {
  it("returns a schema containing elicit_token and does not report destructive: false", () => {
    const registry = buildFullRegistry();
    const def = registry.list().find((d) => d.name === "move_note");
    expect(def).toBeDefined();
    if (!def) return;

    const shape = topLevelShape(def.inputSchema);
    expect(shape, "move_note's input schema shape").toBeDefined();
    expect(shape && "elicit_token" in shape).toBe(true);

    const meta = describeCapability(def) as {
      annotations: { read_only: boolean; destructive: boolean };
    };
    expect(meta.annotations.read_only).toBe(false);
    expect(meta.annotations.destructive).not.toBe(false);
  });
});

describe("THE-824 the gate itself is unweakened (move_note across a folder boundary)", () => {
  it("still refuses without a token (elicit_required + args_hash) and still succeeds with one", async () => {
    const v = makeTestVault({ files: { "src/note.md": "hi" } });
    try {
      const input = { vault: "test", from: "src/note.md", to: "dst/note.md" };

      const need = await v.call("move_note", input);
      expect(need.ok).toBe(false);
      if (need.ok) return;
      expect(need.error.code).toBe("elicit_required");
      const argsHash = (need.error.details as { args_hash?: string }).args_hash;
      expect(typeof argsHash).toBe("string");

      const token = issueElicitToken(v.db, {
        vaultId: v.id,
        toolName: "move_note",
        argsHash: String(argsHash),
        caller: "test",
      });
      const ok = await v.call("move_note", input, { elicitToken: token });
      expect(ok.ok).toBe(true);
      expect(v.exists("dst/note.md")).toBe(true);
    } finally {
      v.cleanup();
    }
  });
});
