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
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

/**
 * Same run, ASYNCHRONOUSLY — required by the bridge test below and by nothing else.
 *
 * `spawnSync` blocks this process's event loop for the whole run, so an in-process HTTP listener
 * standing in for the live Obsidian app can never accept a connection: every bridge request would
 * time out and the test would report "the live app was never reached" no matter what the code did.
 * That is a green-for-the-wrong-reason trap, not a style preference.
 */
function runCliAsync(args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn("bun", [CLI, ...args], { env: { ...process.env, NO_COLOR: "1" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Seed a session + a single recorded `patch_note` trace record directly against the REAL
 *  cache.db, the way a live `serve` session would already have left it — `rerun` only ever reads
 *  what a prior session recorded. `provisionCacheDb` is the same call `wireStores` makes, so the
 *  schema this writes against is the real one, not a hand-picked subset. Returns the session id. */
async function seedSession(
  cacheDir: string,
  vaultId: string,
  records: Array<Record<string, unknown>>,
): Promise<string> {
  const db = await openDatabase(join(cacheDir, "cache.db"));
  provisionCacheDb(db, { version: "test" });
  const id = genSessionId();
  const row = insertSession(db, {
    id,
    vaultId,
    caller: "alice",
    startedAt: 1000,
    tracePath: cacheTraceRelPath(id),
  });
  for (const r of records) appendTrace(join(cacheDir, row.trace_path), r as never);
  db.close?.();
  return id;
}

/** A recorded `patch_note`. `argsVaultId` is separate from the session's vault on purpose: a
 *  record whose CAPTURED args name a different vault is exactly the routing defect below.
 *  Schema-valid per PatchInput (notes/schemas.ts) — an incomplete payload would be refused at
 *  parseInput before dispatch ever reaches the vault-routing question these tests are about. */
function patchRecord(argsVaultId: string, targetPath: string, ts = 1100): Record<string, unknown> {
  return {
    ts,
    type: "tool_invocation",
    tool: "patch_note",
    caller: "alice",
    status: "ok",
    args: JSON.stringify({
      vault: argsVaultId,
      path: targetPath,
      operation: "append",
      anchor: { type: "frontmatter" },
      content: "OVERWRITTEN",
    }),
    args_scan: "clean",
  };
}

async function seedMutatingSession(
  cacheDir: string,
  vaultId: string,
  targetPath: string,
): Promise<string> {
  return seedSession(cacheDir, vaultId, [patchRecord(vaultId, targetPath)]);
}

interface RerunJson {
  summary: { runnable: number; diverged: number };
  records: Array<{
    tool: string;
    // THE-738: a record refused by rerun's own policy reports `divergence: "none"` and no
    // `replayed` payload — asserted by the bridge test below.
    divergence?: string;
    verdict: string;
    replayed: { status: string; error_code?: string } | null;
  }>;
}

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

    const id = await seedMutatingSession(cacheDir, "main", "a.md");

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

    expect(r.code, `rerun exited ${r.code}, stderr: ${r.stderr}`).toBe(0);
    const parsed = JSON.parse(r.stdout) as RerunJson;
    // Belt and suspenders: prove the mutating call was actually DISPATCHED, not silently skipped
    // for some unrelated reason (e.g. a scope/ACL refusal) — otherwise the assertion below would
    // be evidence that nothing ran at all, not evidence that a real write landed on the staged
    // copy instead of the real vault.
    expect(parsed.summary.runnable).toBe(1);
    expect(parsed.records[0]?.replayed?.status).toBe("ok");

    // THE property this file exists to prove.
    expect(readFileSync(join(vaultDir, "a.md"), "utf8")).toBe("original");
  }, 30_000);

  // Fix round 1, finding 1 (CRITICAL, reproduced by review): `vaultRootFor(cfg, undefined)`
  // defaulted to `cfg.vaults[0]` and staged THAT vault, but `rerunSession` dispatches with
  // `vaultId: row.vault_id` — the session's ACTUAL vault — and `expectVaultId` is only checked
  // when `--vault` is given. So a multi-vault config with the session recorded against the
  // SECOND vault, run with `--sandbox` and no `--vault`, staged the wrong (first) vault while the
  // real second vault stayed unstaged — and the mutating call landed on it for real. This repo's
  // own CLAUDE.md documents the production deployment as two vaults, so this was not hypothetical.
  it("a session recorded against the SECOND of two vaults still leaves that vault untouched under --sandbox with no --vault", async () => {
    const vault1Dir = mkdtempSync(join(tmpdir(), "obtc-sbx-v1-"));
    const vault2Dir = mkdtempSync(join(tmpdir(), "obtc-sbx-v2-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-sbx-cache2-"));
    const confDir = mkdtempSync(join(tmpdir(), "obtc-sbx-conf2-"));
    dirs.push(vault1Dir, vault2Dir, cacheDir, confDir);
    writeFileSync(join(vault1Dir, "a.md"), "v1-original");
    writeFileSync(join(vault2Dir, "a.md"), "v2-original");
    const configPath = join(confDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        cacheDir,
        vaults: [
          { id: "vault1", path: vault1Dir },
          { id: "vault2", path: vault2Dir },
        ],
      }),
    );

    // Recorded against vault2 — the vault `vaultRootFor(cfg, undefined)` would NOT have staged.
    const id = await seedMutatingSession(cacheDir, "vault2", "a.md");

    // Deliberately NO --vault: the exact operator shape the defect required.
    const r = runCli(["rerun", id, "--config", configPath, "--sandbox", "--json"]);

    expect(r.code, `rerun exited ${r.code}, stderr: ${r.stderr}`).toBe(0);
    const parsed = JSON.parse(r.stdout) as RerunJson;
    // Non-vacuous: the call must have actually been dispatched (against SOME copy), not skipped.
    expect(parsed.summary.runnable).toBeGreaterThanOrEqual(1);
    expect(parsed.records[0]?.replayed?.status).toBe("ok");

    // THE property: vault2's REAL note — the one the session actually belongs to — is untouched.
    expect(readFileSync(join(vault2Dir, "a.md"), "utf8")).toBe("v2-original");
    // vault1 was never touched either way; asserted for completeness, not the load-bearing check.
    expect(readFileSync(join(vault1Dir, "a.md"), "utf8")).toBe("v1-original");
  }, 30_000);

  // Fix round 2, finding 1 (CRITICAL, MEASURED by review): staging swapped the path of exactly ONE
  // vault — `row.vault_id` — but handlers resolve their target from `input.vault` via
  // `VaultRegistry.resolve`, and `enforceVaultBinding` returned immediately because the runner
  // never set `ctx.vaultBound`. A record whose CAPTURED ARGS named a different vault therefore ran
  // against that vault's REAL, unstaged root, and the command exited 0 — "ran, nothing moved" —
  // while a real note had been rewritten. `vaultBound: true` makes the class structurally
  // impossible: the session row's vault is the only vault either mode can address.
  it("a record whose captured args name ANOTHER vault is refused, while a matching record still runs", async () => {
    const vault1Dir = mkdtempSync(join(tmpdir(), "obtc-sbx-x1-"));
    const vault2Dir = mkdtempSync(join(tmpdir(), "obtc-sbx-x2-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-sbx-cachex-"));
    const confDir = mkdtempSync(join(tmpdir(), "obtc-sbx-confx-"));
    dirs.push(vault1Dir, vault2Dir, cacheDir, confDir);
    writeFileSync(join(vault1Dir, "a.md"), "v1-original");
    writeFileSync(join(vault2Dir, "a.md"), "v2-original");
    const configPath = join(confDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        cacheDir,
        vaults: [
          { id: "vault1", path: vault1Dir },
          { id: "vault2", path: vault2Dir },
        ],
      }),
    );

    // Session belongs to vault2 (so vault2 is what gets staged); the FIRST record's args name
    // vault1 — the vault nothing staged and nothing was checking.
    const id = await seedSession(cacheDir, "vault2", [
      patchRecord("vault1", "a.md", 1100),
      patchRecord("vault2", "a.md", 1200),
    ]);

    const r = runCli(["rerun", id, "--config", configPath, "--sandbox", "--json"]);

    const parsed = JSON.parse(r.stdout) as RerunJson;
    // NOT a silent skip-everything pass: the matching record must still have been dispatched.
    // Without this the "vault1 untouched" assertion below would be evidence that nothing ran.
    expect(parsed.summary.runnable).toBeGreaterThanOrEqual(1);
    expect(parsed.records[1]?.replayed?.status).toBe("ok");
    // The mismatched record is REFUSED, and reported as a real (diverging) outcome rather than
    // folded into `skipped_mutating` — hence exit 1, not 0.
    expect(parsed.records[0]?.replayed?.error_code).toBe("forbidden");
    expect(parsed.records[0]?.verdict).not.toBe("skipped_mutating");
    expect(r.code, `rerun exited ${r.code}, stderr: ${r.stderr}`).toBe(1);

    // THE property this test exists to prove: the real, UNSTAGED vault was not written.
    expect(readFileSync(join(vault1Dir, "a.md"), "utf8")).toBe("v1-original");
    expect(readFileSync(join(vault2Dir, "a.md"), "utf8")).toBe("v2-original");
  }, 30_000);

  // Fix round 2, finding 2 (CRITICAL): a filesystem copy cannot bound a NETWORK-mediated write.
  // Staging swapped `vaults[].path` but not `restApiUrl`/`restApiKey`, so `wireBridges` still built
  // a Local REST API client and `git_stage` POSTed to the LIVE Obsidian app — which operates on the
  // REAL vault — after passing `enforcePathAcl` against the STAGED root. `write:git` is not in
  // `HITL_FLOOR_FAMILIES`, and sandbox mode deliberately lifts the read-only ACL, so nothing else
  // stopped it.
  //
  // The assertion is on a REAL HTTP LISTENER, not on the error code: an unreachable URL would make
  // this pass whether or not the transport was stripped, which is the failure mode where a test
  // goes green for the wrong reason. `probeSkip` + `forceEnabled` remove the startup probe from
  // the picture entirely, so the ONLY request this server can ever see is the `/git/stage` POST.
  it("a recorded plugin-bridge call under --sandbox never reaches the live app", async () => {
    const hits: string[] = [];
    const app = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ staged: 1 }));
    });
    await new Promise<void>((ok) => app.listen(0, "127.0.0.1", ok));
    const port = (app.address() as AddressInfo).port;
    try {
      const vaultDir = mkdtempSync(join(tmpdir(), "obtc-sbx-bridge-vault-"));
      const cacheDir = mkdtempSync(join(tmpdir(), "obtc-sbx-bridge-cache-"));
      const confDir = mkdtempSync(join(tmpdir(), "obtc-sbx-bridge-conf-"));
      dirs.push(vaultDir, cacheDir, confDir);
      writeFileSync(join(vaultDir, "a.md"), "original");
      const configPath = join(confDir, "config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          cacheDir,
          vaults: [
            {
              id: "main",
              path: vaultDir,
              restApiUrl: `http://127.0.0.1:${port}`,
              restApiKey: "test-key",
              // Explicit `live` + probeSkip: the bridge is fully available by configuration, so a
              // refusal can only come from the transport being gone, never from a failed probe.
              mode: "live",
              plugins: { probeSkip: true, forceEnabled: ["git"] },
            },
          ],
        }),
      );

      const id = await seedSession(cacheDir, "main", [
        {
          ts: 1100,
          type: "tool_invocation",
          tool: "git_stage",
          caller: "alice",
          status: "ok",
          args: JSON.stringify({ vault: "main", paths: ["a.md"] }),
          args_scan: "clean",
        },
      ]);

      const r = await runCliAsync(["rerun", id, "--config", configPath, "--sandbox", "--json"]);
      const parsed = JSON.parse(r.stdout) as RerunJson;

      // THE property: the live app was never contacted.
      expect(hits).toEqual([]);
      // And the call failed loudly rather than being silently skipped or reported as a success.
      // THE-738: it is now `refused_by_policy` — the sandbox stripped the bridge, so this is
      // RERUN'S OWN refusal, not the vault answering differently. It must NOT count as divergence
      // (every read-only m4 tool would otherwise report one), but it must still be visible and
      // must still never have reached the app — which `hits` above is what actually proves.
      expect(parsed.records[0]?.tool).toBe("git_stage");
      expect(parsed.records[0]?.verdict).toBe("refused_by_policy");
      expect(parsed.records[0]?.divergence).toBe("none");
    } finally {
      await new Promise<void>((ok) => app.close(() => ok()));
    }
  }, 30_000);

  // Fix round 1, finding 4: the unknown-vault exit(2) path, now driven by the SESSION's own
  // vault_id (finding 1's fix) rather than by `--vault`/`cfg.vaults[0]` — a session whose
  // vault_id names no configured vault must fail loud, the same way prefetch.ts does for an
  // unknown `--vault`.
  it("a session whose vault_id names no configured vault exits 2 under --sandbox", async () => {
    const vaultDir = mkdtempSync(join(tmpdir(), "obtc-sbx-ghost-vault-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "obtc-sbx-ghost-cache-"));
    const confDir = mkdtempSync(join(tmpdir(), "obtc-sbx-ghost-conf-"));
    dirs.push(vaultDir, cacheDir, confDir);
    writeFileSync(join(vaultDir, "a.md"), "original");
    const configPath = join(confDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ cacheDir, vaults: [{ id: "main", path: vaultDir }] }),
    );

    // Recorded against a vault id the config does not declare at all.
    const id = await seedMutatingSession(cacheDir, "ghost", "a.md");

    const r = runCli(["rerun", id, "--config", configPath, "--sandbox", "--json"]);

    expect(r.code, `rerun exited ${r.code}, stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("rerun: unknown vault ghost");
    // Never even reaches staging I/O, let alone a write — the real note is untouched.
    expect(readFileSync(join(vaultDir, "a.md"), "utf8")).toBe("original");
  }, 30_000);
});
