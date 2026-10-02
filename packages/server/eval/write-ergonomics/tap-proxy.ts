// A logging stdio proxy between a REAL MCP client and the obsidian-tc server.
//
// The client (Claude Code / Codex) spawns THIS as its MCP server; it spawns the real server and
// forwards newline-delimited JSON-RPC both ways. It exists for two reasons the clients cannot give
// us themselves:
//   1. a client-independent record of every tools/call with its error code and latency, so the two
//      clients' friction is measured the same way;
//   2. a mid-task hook: after the Nth matching tool response, mutate a vault file BEFORE the
//      response reaches the client. The client cannot act on a note it has just read until it has
//      the response, so this is how "the note changes underneath the model" is simulated without
//      racing it (the CAS / prev_hash path).
//
// Env: TAP_LOG (jsonl path), TAP_SERVER (JSON array: command + args), TAP_VAULT (vault root, for
// hooks), TAP_HOOK (JSON HookSpec, optional), TAP_RAW=1 (also log every raw line, e.g. elicitation). Never forwards anything it did not receive; it only
// ever MUTATES THE VAULT through the hook.
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface HookSpec {
  /** Regex over the effective tool name (the capability name under the triad facade). */
  afterTool: string;
  /** Fire only when args.path equals this. */
  path?: string;
  /** Fire on the Nth matching response (default 1). */
  nth?: number;
  /** Vault-relative file to mutate, and how. */
  file: string;
  appendText?: string;
  replace?: { find: string; with: string };
}

type Json = Record<string, unknown>;

/** `call_capability` carries the real tool in params.arguments.name; flat mode names it directly. */
export function effectiveCall(params: Json | undefined): { tool: string; args: Json } {
  const name = String(params?.name ?? "");
  const a = (params?.arguments ?? {}) as Json;
  if (name === "call_capability")
    return { tool: String(a.name ?? ""), args: (a.args ?? {}) as Json };
  return { tool: name, args: a };
}

/** `afterTool` is a REGEX over the effective tool name (the pre-registered hooks use `^(read_|get_)`);
 *  an earlier cut compared it with `===`, so the hook never fired and the concurrent-edit trials were
 *  not exercised (the runner flags those `notExercised`). */
export function hookMatches(h: HookSpec, tool: string, args: Json): boolean {
  return new RegExp(h.afterTool).test(tool) && (h.path === undefined || args.path === h.path);
}

export function applyHook(vault: string, h: HookSpec): void {
  const p = join(vault, h.file);
  if (h.appendText !== undefined) {
    appendFileSync(p, h.appendText);
    return;
  }
  if (h.replace) {
    const cur = readFileSync(p, "utf8");
    if (!cur.includes(h.replace.find)) throw new Error(`hook find text absent from ${h.file}`);
    writeFileSync(
      p,
      cur.replace(h.replace.find, () => h.replace?.with ?? ""),
    );
  }
}

function main(): void {
  const log = process.env.TAP_LOG ?? "tap.jsonl";
  const server = JSON.parse(process.env.TAP_SERVER ?? "[]") as string[];
  const vault = process.env.TAP_VAULT ?? "";
  const hook = process.env.TAP_HOOK ? (JSON.parse(process.env.TAP_HOOK) as HookSpec) : undefined;
  const emit = (o: Json): void =>
    appendFileSync(log, `${JSON.stringify({ t: Date.now(), ...o })}\n`);
  const [cmd, ...args] = server;
  if (!cmd) throw new Error("TAP_SERVER is empty");
  const child: ChildProcess = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr?.on("data", (d: Buffer) => {
    appendFileSync(`${log}.stderr`, d);
  });

  const pending = new Map<string | number, { tool: string; args: Json; sent: number }>();
  let matched = 0;
  let fired = false;

  const raw = process.env.TAP_RAW === "1";
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (raw) emit({ dir: "raw-c2s", line: line.slice(0, 700) });
    try {
      const m = JSON.parse(line) as Json;
      if (m.method === "initialize") {
        emit({
          dir: "c2s",
          method: "initialize",
          clientInfo: (m.params as Json | undefined)?.clientInfo,
        });
      } else if (m.method === "tools/call" && m.id !== undefined) {
        const { tool, args: a } = effectiveCall(m.params as Json);
        pending.set(m.id as string | number, { tool, args: a, sent: Date.now() });
      } else if (m.method === "tools/list" && m.id !== undefined) {
        pending.set(m.id as string | number, { tool: "<tools/list>", args: {}, sent: Date.now() });
      }
    } catch {
      /* forward anyway */
    }
    child.stdin?.write(`${line}\n`);
  });
  process.stdin.on("end", () => child.stdin?.end());

  createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
    if (raw) emit({ dir: "raw-s2c", line: line.slice(0, 700) });
    try {
      const m = JSON.parse(line) as Json;
      const p = m.id !== undefined ? pending.get(m.id as string | number) : undefined;
      if (p) {
        pending.delete(m.id as string | number);
        const result = (m.result ?? {}) as Json;
        const sc = result.structuredContent as Json | undefined;
        const text = JSON.stringify(result.content ?? "");
        emit({
          dir: "s2c",
          tool: p.tool,
          args: p.args,
          ms: Date.now() - p.sent,
          isError: result.isError === true || m.error !== undefined,
          code: typeof sc?.code === "string" ? sc.code : undefined,
          recovery: typeof sc?.recovery === "string" ? sc.recovery : undefined,
          bytes: Buffer.byteLength(line),
          text: text.slice(0, 1500),
        });
        if (hook && !fired && hookMatches(hook, p.tool, p.args) && ++matched >= (hook.nth ?? 1)) {
          fired = true;
          applyHook(vault, hook);
          emit({ dir: "hook", file: hook.file, afterTool: hook.afterTool });
        }
      }
    } catch (e) {
      emit({ dir: "proxy-error", error: String(e) });
    }
    process.stdout.write(`${line}\n`);
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  for (const s of ["SIGTERM", "SIGINT"] as const) process.on(s, () => child.kill(s));
}

if ((import.meta as unknown as { main?: boolean }).main) main();
