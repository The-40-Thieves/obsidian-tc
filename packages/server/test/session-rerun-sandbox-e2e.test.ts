// THE-645 item 3 — the CRITICAL property `stageSandbox` alone cannot prove: `rerun --sandbox`
// must not touch the real vault when it re-issues a recorded MUTATING call.
//
// session-rerun.test.ts's own "sandbox staging" describe block only exercises `stageSandbox` in
// isolation — it proves a disposable copy gets made, never that the CLI actually ROUTES a
// re-issued call through it. That gap was real, not hypothetical: the task brief's own Step 5
// snippet passed `staged.root`/`staged.cacheDir` only into `rerunSession`'s OPTIONS, which resolve
// nothing but the TRACE file (workspace/sessions.ts's `resolveTraceAbs`). The ToolRegistry that
// actually performs a re-issued `patch_note` is built ONCE, at `buildServerRuntime` construction
// time, from the config's own `vaults[].path` (runtime/governance.ts's `VaultRegistry`) and
// `cacheDir` (runtime/stores.ts's `wireStores`) — untouched by anything `rerunSession` is handed.
// So threading the staged paths only into `rerunSession` left every dispatch pointed at the REAL
// vault and REAL cache.db regardless of `--sandbox`.
//
// MEASURED, not assumed: reverting `cli/commands/rerun.ts` to that literal brief snippet (keeping
// `buildServerRuntime`/`openDatabase` on the unmodified `cfg`) and running the test below made it
// fail with `expected 'original\nOVERWRITTEN' to be 'original'` — the real vault's note was
// overwritten for real. The fix is to build a SANDBOXED config (target vault's `path` and
// `cacheDir` swapped to the staged copies) and construct the runtime from THAT, before ever
// calling `buildServerRuntime`.
//
// SUBPROCESS, not an import — mirroring cli-smoke.test.ts's own rationale: `main()` calls
// `process.exit` in several places and `run_rerun` itself sets `process.exitCode`, so importing it
// directly risks corrupting this test run's own exit code. Spawning the real CLI is the only way
// to observe the actual operator-facing surface (real argv parsing, real process boundary) without
// that risk, and it is also the most faithful "run_rerun end to end" available.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import {
  appendTrace,
  cacheTraceRelPath,
  genSessionId,
  insertSession,
} from "../src/workspace/sessions";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Run {
  const r = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("THE-645 item 3 — rerun --sandbox does not touch the real vault (end to end)", () => {
  it("re-issuing a recorded patch_note under --sandbox leaves the real note untouched", async () => {
    const vaultDir = mkdtempSync(join(tmpdir(), "obtc-sbx-vault-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-sbx-cache-"));
    const confDir = mkdtempSync(join(tmpdir(), "obtc-sbx-conf-"));
    dirs.push(vaultDir, cacheDir, confDir);
    writeFileSync(join(vaultDir, "a.md"), "original");
    const configPath = join(confDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ cacheDir, vaults: [{ id: "main", path: vaultDir }] }),
    );

    // Seed the session + trace directly against the REAL cache.db, the way a live `serve` session
    // would already have left it — `rerun` only ever reads what a prior session recorded, and
    // provisioning here is the same `provisionCacheDb` runtime/stores.ts's `wireStores` calls, so
    // the schema this writes against is the real one, not a hand-picked subset.
    const db = await openDatabase(join(cacheDir, "cache.db"));
    provisionCacheDb(db, { version: "test" });
    const id = genSessionId();
    const row = insertSession(db, {
      id,
      vaultId: "main",
      caller: "alice",
      startedAt: 1000,
      tracePath: cacheTraceRelPath(id),
    });
    // Schema-valid per PatchInput (notes/schemas.ts) — an incomplete payload would be refused at
    // parseInput before dispatch ever reaches the vault-routing question this test is about.
    appendTrace(join(cacheDir, row.trace_path), {
      ts: 1100,
      type: "tool_invocation",
      tool: "patch_note",
      caller: "alice",
      status: "ok",
      args: JSON.stringify({
        vault: "main",
        path: "a.md",
        operation: "append",
        anchor: { type: "frontmatter" },
        content: "OVERWRITTEN",
      }),
      args_scan: "clean",
    } as never);
    db.close?.();

    const r = runCli([
      "rerun",
      id,
      "--config",
      configPath,
      "--vault",
      "main",
      "--sandbox",
      "--json",
    ]);

    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      summary: { runnable: number };
      records: Array<{ replayed: { status: string } | null }>;
    };
    // Belt and suspenders: prove the mutating call was actually DISPATCHED, not silently skipped
    // for some unrelated reason (e.g. a scope/ACL refusal) — otherwise the assertion below would
    // be evidence that nothing ran at all, not evidence that a real write landed on the staged
    // copy instead of the real vault.
    expect(parsed.summary.runnable).toBe(1);
    expect(parsed.records[0]?.replayed?.status).toBe("ok");

    // THE property this file exists to prove.
    expect(readFileSync(join(vaultDir, "a.md"), "utf8")).toBe("original");
  }, 30_000);
});
