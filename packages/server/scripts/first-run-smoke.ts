// First-run smoke: does a clean install of ONE distribution path boot with no config and answer a
// semantic query over MCP stdio? Run once per path x OS by .github/workflows/ci-first-run-smoke.yml.
//
//   bun scripts/first-run-smoke.ts --path npm    [--npm-spec obsidian-tc@latest]
//   bun scripts/first-run-smoke.ts --path mcpb   --artifact dist/obsidian-tc.mcpb
//   bun scripts/first-run-smoke.ts --path binary --artifact dist/obsidian-tc-bun-linux-x64
//   bun scripts/first-run-smoke.ts --path cli    --artifact packages/server/dist/cli.js  (dev / tests)
//     [--report <file.json>] [--reconcile-timeout-ms <ms>] [--boot-timeout-ms <ms>]
//     [--model-cache <dir>]
//
// What it does, per path: install/unpack the artifact the way a user gets it, start it against a
// five-note fixture vault with NO config file (the vault directory is the only argument, as `npx
// obsidian-tc <vault>` and the .mcpb's pasted-folder user_config do), wait for the boot reconcile to
// settle, then call search_semantic through the facade and check WHICH retriever answered.
//
// Unlike zero-config-smoke.ts (which asserts one expected state and exits at the first miss) this
// MEASURES: every stage is recorded as pass / fail / skip / info, later stages still run when an
// earlier one failed (a degraded index still tells us what search_semantic does), and the exit code
// is 1 when any stage failed. `--report` writes the per-stage JSON the workflow folds into the 3x3
// table; its `firstFailure` is the exact one-line reason. It reuses zero-config-smoke's isolated
// HOME (scripts/lib/isolated-home.mjs), so the run never reads or writes the operator's real
// `~/.obsidian-tc`, and the same `--model-cache` shape for CI's model-weights cache.
//
// Stages: prepare, node-floor (mcpb only), boot, banner, vec, reconcile, search_semantic,
// search_vault (info), shutdown. `native` is reported, never failed: the JS fallback is a supported
// state. `vec=off` IS a failure: it means dense retrieval fell back to the brute-force scan.
//
// The mcpb path is run as a desktop host runs an extension: unpack the bundle, read its
// manifest's server.mcp_config, expand ${__dirname} / ${user_config.*}, spawn `node` from PATH
// with those args and env. ASSUMPTION (documented, not verified per host): the host's Node is
// whatever `node` resolves to, here the runner's Node 24 (CI's supported floor). Real hosts bundle
// their own Node; see the PR for what each documents.

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  buildReport,
  classifySemantic,
  expandMcpbVars,
  failureLine,
  nodeSatisfies,
  parseBanner,
  toolPayload,
} from "./lib/first-run-smoke-lib.mjs";
import { createIsolatedHome, removeTree, waitForPidExit } from "./lib/isolated-home.mjs";

type Status = "pass" | "fail" | "skip" | "info";
interface StageResult {
  stage: string;
  status: Status;
  detail: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

// Keep in step with scripts/bundle-mcpb.ts's MCPB constant (first-run-smoke.test.ts asserts it).
const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";

const pathKind = arg("--path");
const artifact = arg("--artifact");
const npmSpec = arg("--npm-spec") ?? "obsidian-tc@latest";
const reportFile = arg("--report");
const modelCache = arg("--model-cache");
const reconcileTimeoutMs = Number(arg("--reconcile-timeout-ms") ?? "300000");
const bootTimeoutMs = Number(arg("--boot-timeout-ms") ?? "120000");
// `--env KEY=VALUE` (repeatable): extra environment for the child. A test hook for the stub server.
const extraEnv = Object.fromEntries(
  process.argv.flatMap((a, i) =>
    a === "--env"
      ? [
          String(process.argv[i + 1])
            .split(/=(.*)/s)
            .slice(0, 2),
        ]
      : [],
  ),
) as Record<string, string>;

if (!pathKind || !["npm", "mcpb", "binary", "cli"].includes(pathKind)) {
  process.stderr.write("first-run-smoke: --path npm|mcpb|binary|cli is required\n");
  process.exit(2);
}
if (pathKind !== "npm" && !artifact) {
  process.stderr.write(`first-run-smoke: --path ${pathKind} needs --artifact <file>\n`);
  process.exit(2);
}

const stages: StageResult[] = [];
function rec(stage: string, status: Status, detail: string): void {
  stages.push({ stage, status, detail });
  process.stderr.write(`[${status.toUpperCase().padEnd(4)}] ${stage}: ${detail}\n`);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The fixture: five notes on unrelated topics, no wikilinks. The paraphrase query shares no word
 *  with its target note, so only a real dense retriever ranks it first (a lexical fallback or a
 *  hash-style fake embedder cannot). */
const SEMANTIC_QUERY = "how do I keep my bread leaven healthy and bubbling";
const SEMANTIC_TARGET = "sourdough.md";
function makeFixtureVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "obtc-first-run-vault-"));
  process.once("exit", () => removeTree(dir));
  const notes: Record<string, string> = {
    "sourdough.md":
      "# Sourdough starter\n\nFeed the starter equal weights of flour and water every morning, and discard half first so the culture stays vigorous.\n",
    "kubernetes.md":
      "# Kubernetes rollout\n\nA deployment replaces pods gradually; a readiness probe gates traffic until the new pod answers.\n",
    "tomatoes.md":
      "# Tomato garden\n\nWater tomato plants deeply at the roots in the early morning and pinch off the suckers.\n",
    "telescope.md":
      "# Telescope notes\n\nJupiter's four largest moons are visible through a small refractor on a clear night.\n",
    "budget.md":
      "# Household budget\n\nRent, groceries and utilities come out first; whatever remains goes to the savings account.\n",
  };
  for (const [name, body] of Object.entries(notes)) writeFileSync(join(dir, name), body);
  return dir;
}

interface Launch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** spawnSync that works for npm/npx on Windows, where they are .cmd shims. */
function run(command: string, args: string[], timeoutMs: number): { ok: boolean; out: string } {
  const r = spawnSync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    shell: process.platform === "win32",
  });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  return { ok: r.status === 0 && !r.error, out: r.error ? `${out}\n${r.error.message}` : out };
}

function prepareNpm(vault: string): Launch | null {
  const prefix = mkdtempSync(join(tmpdir(), "obtc-first-run-npm-"));
  process.once("exit", () => removeTree(prefix));
  const t0 = Date.now();
  const r = run(
    "npm",
    ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--loglevel", "error", npmSpec],
    600_000,
  );
  if (!r.ok) {
    rec("prepare", "fail", `npm install ${npmSpec}: ${failureLine(r.out)}`);
    return null;
  }
  const pkgDir = join(prefix, "node_modules", "obsidian-tc");
  const version = (
    JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { version: string }
  ).version;
  const embedder = existsSync(
    join(prefix, "node_modules", "@the-40-thieves", "obsidian-tc-embedder-local"),
  );
  rec(
    "prepare",
    "pass",
    `npm install ${npmSpec} -> obsidian-tc@${version} in ${Date.now() - t0}ms; embedder-local ${embedder ? "installed" : "NOT installed"}`,
  );
  // The bin shim npm generates is what `npx obsidian-tc` / a global install runs.
  const bin = join(
    prefix,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "obsidian-tc.cmd" : "obsidian-tc",
  );
  if (!existsSync(bin)) {
    rec("prepare", "fail", `npm install produced no bin shim at ${bin}`);
    return null;
  }
  return { command: bin, args: [vault], env: {} };
}

function prepareMcpb(vault: string): Launch | null {
  const bundle = resolve(artifact as string);
  const dir = mkdtempSync(join(tmpdir(), "obtc-first-run-mcpb-"));
  process.once("exit", () => removeTree(dir));
  const r = run("npx", ["-y", MCPB_CLI, "unpack", bundle, dir], 300_000);
  if (!r.ok) {
    rec("prepare", "fail", `mcpb unpack: ${failureLine(r.out)}`);
    return null;
  }
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
    version: string;
    compatibility?: { runtimes?: { node?: string } };
    server: { mcp_config: { command: string; args: string[]; env?: Record<string, string> } };
  };
  const cfg = manifest.server.mcp_config;
  // The user pastes the vault folder into the required `config_path` field (zero-config); the
  // optional default_vault stays blank.
  const vars = { dirname: dir, userConfig: { config_path: vault, default_vault: "" } };
  const args = cfg.args.map((a) => expandMcpbVars(a, vars));
  const env = Object.fromEntries(
    Object.entries(cfg.env ?? {}).map(([k, v]) => [k, expandMcpbVars(v, vars)]),
  );
  const entry = args[0];
  if (!entry || !existsSync(entry)) {
    rec(
      "prepare",
      "fail",
      `bundle ${manifest.version}: mcp_config entry ${String(entry)} is not in the unpacked bundle`,
    );
    return null;
  }
  rec("prepare", "pass", `unpacked mcpb ${manifest.version}; entry ${cfg.command} ${entry}`);

  // A host that honours compatibility.runtimes refuses to start on a Node below the floor; the
  // runner's Node is the stand-in for the host's, so measure it against the declared floor.
  const floor = manifest.compatibility?.runtimes?.node;
  try {
    const nodeVersion = execFileSync(cfg.command, ["--version"], {
      encoding: "utf8",
      shell: process.platform === "win32",
    }).trim();
    if (floor === undefined)
      rec("node-floor", "info", `no node floor declared; ${cfg.command} is ${nodeVersion}`);
    else if (nodeSatisfies(nodeVersion, floor))
      rec("node-floor", "pass", `${cfg.command} ${nodeVersion} satisfies manifest "${floor}"`);
    else rec("node-floor", "fail", `${cfg.command} ${nodeVersion} is below manifest "${floor}"`);
  } catch (e) {
    rec("node-floor", "fail", `could not run \`${cfg.command} --version\`: ${errText(e)}`);
  }
  return { command: cfg.command, args, env };
}

function prepareBinary(vault: string): Launch | null {
  let bin = resolve(artifact as string);
  if (!existsSync(bin) && existsSync(`${bin}.exe`)) bin = `${bin}.exe`;
  if (!existsSync(bin)) {
    rec("prepare", "fail", `compiled binary not found at ${bin}`);
    return null;
  }
  chmodSync(bin, 0o755);
  rec("prepare", "pass", `binary ${bin}`);
  return { command: bin, args: [vault], env: {} };
}

function prepareCli(vault: string): Launch {
  const cli = resolve(artifact as string);
  rec("prepare", "pass", `node ${cli}`);
  return { command: "node", args: [cli, vault], env: {} };
}

async function main(): Promise<void> {
  const vault = makeFixtureVault();
  const launch =
    pathKind === "npm"
      ? prepareNpm(vault)
      : pathKind === "mcpb"
        ? prepareMcpb(vault)
        : pathKind === "binary"
          ? prepareBinary(vault)
          : prepareCli(vault);

  if (launch) await exercise(launch);
  else
    for (const s of ["boot", "banner", "vec", "reconcile", "search_semantic", "shutdown"])
      rec(s, "skip", "prepare failed");

  const report = buildReport({
    path: pathKind as string,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    stages,
  });
  if (reportFile) writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `FIRST-RUN ${pathKind} ${process.platform}-${process.arch}: ${report.result.toUpperCase()}${report.firstFailure ? ` (${report.firstFailure})` : ""}\n`,
  );
  process.exit(report.result === "pass" ? 0 : 1);
}

async function exercise(launch: Launch): Promise<void> {
  const isolated = createIsolatedHome("obtc-first-run-home-");
  const isolatedModels = join(isolated.home, ".obsidian-tc", "models");
  if (modelCache && existsSync(modelCache)) cpSync(modelCache, isolatedModels, { recursive: true });

  let stderrText = "";
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    stderr: "pipe",
    env: { ...extraEnv, ...launch.env, ...isolated.env },
  });
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrText += chunk.toString("utf8");
  });
  const client = new Client({ name: "first-run-smoke", version: "0.0.0" });
  let closed = false;
  client.onclose = () => {
    closed = true;
  };

  try {
    await withTimeout(client.connect(transport), bootTimeoutMs, "MCP initialize");
    rec("boot", "pass", "initialize succeeded over stdio");
  } catch (e) {
    rec("boot", "fail", `${failureLine(stderrText, errText(e))} [${errText(e)}]`);
    for (const s of ["banner", "vec", "reconcile", "search_semantic"])
      rec(s, "skip", "boot failed");
    await shutdown(transport, client, isolated.cleanup, () => closed);
    return;
  }

  // The banner is written before the transport connects, but it is a separate pipe: give it a beat.
  for (let i = 0; i < 50 && !parseBanner(stderrText); i++)
    await new Promise((r) => setTimeout(r, 100));
  const banner = parseBanner(stderrText);
  if (!banner) {
    rec("banner", "fail", `no "ready on stdio" boot banner on stderr: ${failureLine(stderrText)}`);
    rec("vec", "skip", "no banner");
  } else {
    rec(
      "banner",
      "pass",
      `obsidian-tc ${banner.version} ready; native=${banner.native} vec=${banner.vec}`,
    );
    if (banner.vec === "on") rec("vec", "pass", "sqlite-vec loaded (vec=on)");
    else
      rec(
        "vec",
        "fail",
        "vec=off: sqlite-vec did not load, dense retrieval falls back to the brute-force scan",
      );
  }

  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name: "call_capability", arguments: { name, args } });

  // Wait for the boot reconcile (the first index pass, including the embedder's model load).
  let reconcile = "pending";
  let statusDetail = "";
  const reconcileStart = Date.now();
  try {
    const deadline = reconcileStart + reconcileTimeoutMs;
    for (;;) {
      const res = await call("get_index_status", {});
      const p = toolPayload(res) as
        | { reconcile?: string; vec_enabled?: boolean; chunks_upserted?: number | null }
        | undefined;
      reconcile = p?.reconcile ?? "unreadable";
      statusDetail = `vec_enabled=${String(p?.vec_enabled)} chunks_upserted=${String(p?.chunks_upserted)}`;
      if (reconcile !== "pending") break;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch (e) {
    reconcile = "unreadable";
    statusDetail = errText(e);
  }
  if (reconcile === "ok")
    rec("reconcile", "pass", `reconcile=ok after ${Date.now() - reconcileStart}ms ${statusDetail}`);
  else {
    let why = "";
    try {
      const health = toolPayload(await call("server_health", {})) as
        | { index?: { detail?: { reconcile_errors?: Array<{ error: string }> } } }
        | undefined;
      const first = health?.index?.detail?.reconcile_errors?.[0]?.error;
      if (first) why = ` -- ${failureLine(first)}`;
    } catch {
      // server_health is best-effort context for the failure line
    }
    if (!why) why = ` -- ${failureLine(stderrText, "no stderr")}`;
    rec(
      "reconcile",
      "fail",
      `reconcile=${reconcile} after ${Date.now() - reconcileStart}ms (${statusDetail})${why}`,
    );
  }

  // search_semantic: runs even after a degraded reconcile, because what it does then is data.
  try {
    const res = await withTimeout(
      call("search_semantic", { vault: "main", query: SEMANTIC_QUERY, k: 5 }),
      120_000,
      "search_semantic",
    );
    const c = classifySemantic(res, SEMANTIC_TARGET);
    rec("search_semantic", c.kind === "semantic" ? "pass" : "fail", `${c.kind}: ${c.detail}`);
  } catch (e) {
    rec("search_semantic", "fail", `error: ${errText(e)}`);
  }

  // Informational: which retriever search_vault's auto mode picks for the same query.
  try {
    const res = await call("search_vault", { vault: "main", query: SEMANTIC_QUERY, mode: "auto" });
    const p = toolPayload(res) as
      | { mode_used?: string; tried?: string[]; items?: unknown[] }
      | undefined;
    rec(
      "search_vault",
      "info",
      res.isError
        ? `error: ${failureLine(JSON.stringify(res.content))}`
        : `auto mode_used=${String(p?.mode_used)} tried=${JSON.stringify(p?.tried)} hits=${p?.items?.length ?? 0}`,
    );
  } catch (e) {
    rec("search_vault", "info", `error: ${errText(e)}`);
  }

  if (modelCache && existsSync(isolatedModels)) {
    mkdirSync(modelCache, { recursive: true });
    cpSync(isolatedModels, modelCache, { recursive: true });
  }
  await shutdown(transport, client, isolated.cleanup, () => closed);
}

async function shutdown(
  transport: StdioClientTransport,
  client: Client,
  cleanup: () => void,
  isClosed: () => boolean,
): Promise<void> {
  const pid = transport.pid;
  try {
    await withTimeout(client.close(), 10_000, "client.close");
  } catch {
    // fall through to the explicit kill below
  }
  if (pid === null) {
    rec("shutdown", "info", "no child pid (it never spawned)");
  } else if (await waitForPidExit(pid, 10_000)) {
    rec("shutdown", "pass", `child exited after close (closed=${String(isClosed())})`);
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    rec("shutdown", "fail", "child still alive 10s after the client closed; killed");
  }
  cleanup();
}

main().catch((e) => {
  process.stderr.write(`first-run-smoke: harness error: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(2);
});
