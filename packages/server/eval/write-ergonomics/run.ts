// Write-ergonomics eval: real LLM clients write, fix and edit notes through obsidian-tc.
//
// Usage:
//   bun eval/write-ergonomics/run.ts --root <dir> --client claude|codex [--tasks id,id] [--arm main|hardened]
//        [--rep N] [--timeout-s 240] [--budget-tokens 3000000] [--runs runs] [--raw]
// Needs the template built first (bun eval/write-ergonomics/template.ts <root>) and dist/cli.js built.
//
// Each trial: fresh copy of the template vault + warm cache, a config in the run dir, the client
// spawned headless against the tap proxy, then the task's deterministic checker over the vault.
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { type ClientCtx, type ClientOut, runClaude, runCodex } from "./clients";
import { writeConfig } from "./config";
import { friction, readTap, toCalls } from "./friction";
import { TASKS, type Task } from "./tasks";
import { copyTemplate, livePaths } from "./template";

const CLI = resolve(import.meta.dirname, "../../dist/cli.js");

export interface TrialResult {
  client: string;
  task: string;
  arm: string;
  rep: number;
  pass: boolean;
  detail: string;
  finalText: string;
  usage: ClientOut["usage"];
  turns: number;
  costUsd?: number;
  wallMs: number;
  exit: number | null;
  timedOut: boolean;
  otherTools: string[];
  model?: string;
  friction: ReturnType<typeof friction>;
  /** The hook never fired, so a CAS/concurrency task was not actually exercised. */
  notExercised: boolean;
  runDir: string;
}

const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

export function runTrial(
  root: string,
  client: "claude" | "codex",
  task: Task,
  rep: number,
  timeoutMs: number,
  runsDir = "runs",
  raw = false,
): TrialResult {
  const runDir = join(root, runsDir, task.arm, client, `${task.id}__r${rep}`);
  if (existsSync(runDir))
    throw new Error(`${runDir} exists: runs are never overwritten (use a new --rep)`);
  const live = livePaths(root);
  const { vault, cache, config } = live;
  const workDir = join(runDir, "work");
  mkdirSync(workDir, { recursive: true });
  copyTemplate(root);
  writeConfig(config, task.arm, vault, cache);
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const shim = join(binDir, "obsidian-tc");
  writeFileSync(shim, `#!/bin/sh\nexec node ${CLI} "$@"\n`);
  chmodSync(shim, 0o755);

  const tapLog = join(runDir, "tap.jsonl");
  const tapEnv: Record<string, string> = {
    TAP_LOG: tapLog,
    TAP_VAULT: vault,
    TAP_SERVER: JSON.stringify(["node", CLI, "serve", config]),
    ...(task.hook ? { TAP_HOOK: JSON.stringify(task.hook) } : {}),
    ...(raw ? { TAP_RAW: "1" } : {}),
  };
  const ctx: ClientCtx = {
    runDir,
    workDir,
    mcpConfig: join(runDir, "mcp.json"),
    serverCmd: ["node", CLI, "serve", config],
    tapEnv,
    prompt: task.prompt,
    elicit: task.hitl === "approved",
    binDir,
    config,
    timeoutMs,
  };
  const t0 = Date.now();
  const out = client === "claude" ? runClaude(ctx) : runCodex(ctx, cache);
  const wallMs = Date.now() - t0;
  writeFileSync(join(runDir, "client.out"), out.raw);

  const tap = readTap(tapLog);
  const fr = friction(tap);
  let check = { pass: false, detail: "checker threw" };
  try {
    check = task.check({ vault, finalText: out.finalText, calls: toCalls(tap) });
  } catch (e) {
    check = { pass: false, detail: `checker error: ${e instanceof Error ? e.message : String(e)}` };
  }
  // Archive the post-run state beside the transcript (never deleted), freeing the live path.
  const arch = { vault: join(runDir, "vault"), cache: join(runDir, "cache") };
  renameSync(vault, arch.vault);
  renameSync(cache, arch.cache);
  renameSync(config, join(runDir, "config.json"));
  renameSync(live.dir, join(runDir, "live-leftover"));
  const res: TrialResult = {
    client,
    task: task.id,
    arm: task.arm,
    rep,
    pass: check.pass,
    detail: check.detail,
    finalText: out.finalText,
    usage: out.usage,
    turns: out.turns,
    costUsd: out.costUsd,
    wallMs,
    exit: out.exit,
    timedOut: out.timedOut,
    otherTools: out.otherTools,
    model: out.model,
    friction: fr,
    notExercised: Boolean(task.hook) && !fr.hookFired,
    runDir,
  };
  writeFileSync(join(runDir, "result.json"), JSON.stringify(res, null, 2));
  return res;
}

function main(): void {
  const argv = process.argv.slice(2);
  const root = resolve(flag(argv, "--root") ?? "");
  const client = flag(argv, "--client");
  if (!root || (client !== "claude" && client !== "codex"))
    throw new Error(
      "usage: run.ts --root <dir> --client claude|codex [--tasks a,b] [--arm main|hardened] [--rep N]",
    );
  const only = flag(argv, "--tasks")?.split(",");
  const arm = flag(argv, "--arm");
  const rep = Number(flag(argv, "--rep") ?? 1);
  const timeoutMs = Number(flag(argv, "--timeout-s") ?? 240) * 1000;
  const budget = Number(flag(argv, "--budget-tokens") ?? 3_000_000);
  const tasks = TASKS.filter((t) => (!only || only.includes(t.id)) && (!arm || t.arm === arm));
  if (tasks.length === 0) throw new Error("no tasks selected");
  const ledger = join(root, "token-ledger.jsonl");
  let spent = 0;
  try {
    for (const l of readFileSync(ledger, "utf8").split("\n").filter(Boolean))
      spent += (JSON.parse(l) as { billable: number }).billable;
  } catch {
    /* first run */
  }
  for (const task of tasks) {
    if (spent > budget) {
      process.stderr.write(`STOP: billable client tokens ${spent} exceed budget ${budget}\n`);
      process.exit(3);
    }
    const r = runTrial(
      root,
      client,
      task,
      rep,
      timeoutMs,
      flag(argv, "--runs") ?? "runs",
      argv.includes("--raw"),
    );
    spent += r.usage.billable;
    appendFileSync(
      ledger,
      `${JSON.stringify({ client, task: task.id, rep, billable: r.usage.billable, cacheRead: r.usage.cacheRead })}\n`,
    );
    process.stdout.write(
      `${client} ${task.arm}/${task.id} r${rep}: ${r.pass ? "PASS" : "FAIL"} calls=${r.friction.toolsCalls} err=${r.friction.errors} tok=${r.usage.billable} ${(r.wallMs / 1000).toFixed(0)}s${r.pass ? "" : ` -- ${r.detail}`}\n`,
    );
  }
}

if ((import.meta as unknown as { main?: boolean }).main) main();
