// THE-645 item 3, fix round 1 — the covering test for the PRODUCTION registry shape.
//
// session-rerun.test.ts's mutation cycle only ever exercised the per-call `ctx.acl` this runner
// sets directly, which is real (`makeTestVault`'s registry wires no `aclResolver`, so nothing
// overwrites it — m1-helpers.ts:75) but is NOT the shape production runs. `buildServerRuntime`'s
// registry DOES wire an `aclResolver`, and `applyVaultAcl` (`dispatch.ts:197` ->
// `input-binding.ts:88`) REPLACES `ctx.acl` with the resolver's answer on every call naming a
// vault — overwriting whatever this runner set, before `enforceReadOnlyGate`
// (`policy-gates.ts:132-135`) ever reads it. A green mutation cycle against `makeTestVault` alone
// is therefore zero evidence about the mechanism that actually holds once Task 4's
// `withReadOnlyAcl` wires a real resolver.
//
// So this file builds a registry shaped like production instead: an `aclResolver` wired at
// construction time, exactly the idiom `test/per-vault-acl.test.ts` (THE-295) uses. `makeTestVault`
// cannot be reused here — it builds its own registry with no `aclResolver` by construction.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { ToolRegistry } from "../src/mcp/registry";
import { registerM1Tools } from "../src/tools/m1";
import { VaultRegistry } from "../src/vault/registry";
import { rerunSession } from "../src/workspace/rerun";
import { appendTrace, insertSession } from "../src/workspace/sessions";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

/** A registry built the way `buildServerRuntime` builds one: `aclResolver` wired at construction,
 *  returning the SAME `FolderAcl` for every vault id — the shape Task 4's `withReadOnlyAcl` will
 *  produce. `readOnly` is the knob Step-5-equivalent mutation below flips. */
function harness(readOnly: boolean) {
  const root = mkdtempSync(join(tmpdir(), "obtc-rerun-prodacl-"));
  const write = (rel: string, content: string): void => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  const db: Database = openMemoryDb();
  provisionCacheDb(db);
  const acl = new FolderAcl({ readOnly, defaultScopes: [], rules: [] });
  const registry = new ToolRegistry({ aclResolver: () => acl });
  registerM1Tools(registry, {
    vaultRegistry: new VaultRegistry([{ id: "v", path: root }]),
    version: "test",
    startedAt: 0,
    embeddings: { provider: "ollama", model: "nomic-embed-text" },
  });
  return {
    db,
    registry,
    root,
    write,
    read: (rel: string) => readFileSync(join(root, rel), "utf8"),
    cleanup: () => rmTemp(root),
  };
}

describe("THE-645 item 3 fix round 1 — rerun against a registry with a wired aclResolver", () => {
  let h: ReturnType<typeof harness> | undefined;
  let cacheDir: string | undefined;
  afterEach(() => {
    h?.cleanup();
    if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
    cacheDir = undefined;
  });

  it("DOES NOT WRITE when the registry's own aclResolver returns read-only — asserted on the note, not the verdict", async () => {
    h = harness(true);
    h.write("a.md", "original");
    cacheDir = mkdtempSync(join(tmpdir(), "obtc-rerun-prodacl-cache-"));

    const id = "sess_prodacl";
    const row = insertSession(h.db, {
      id,
      vaultId: "v",
      caller: "alice",
      startedAt: 1000,
      tracePath: `traces/${id}.jsonl`,
    });
    appendTrace(join(cacheDir, row.trace_path), {
      ts: 1100,
      type: "tool_invocation",
      tool: "patch_note",
      caller: "alice",
      status: "ok",
      // Schema-valid per PatchInput (notes/schemas.ts) — see session-rerun.test.ts's header note
      // on why an incomplete payload here would mask the gate under test entirely.
      args: JSON.stringify({
        vault: "v",
        path: "a.md",
        operation: "append",
        anchor: { type: "frontmatter" },
        content: "OVERWRITTEN",
      }),
      args_scan: "clean",
    } as never);

    await rerunSession({
      db: h.db,
      registry: h.registry,
      sessionId: id,
      cacheDir,
      vaultRootFor: () => (h as ReturnType<typeof harness>).root,
    });

    // THE property, same as session-rerun.test.ts's own no-write test: not `verdict ===
    // "skipped_mutating"` — that only proves the runner printed the right word. This is the note
    // on disk, checked against a registry that overwrites this runner's own `ctx.acl`, so a
    // pass here is evidence about `withReadOnlyAcl`'s mechanism, not about the per-call one.
    expect(h.read("a.md")).toBe("original");
  });
});
