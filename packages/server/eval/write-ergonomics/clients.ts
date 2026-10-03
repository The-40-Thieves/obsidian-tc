// Headless drivers for the two real clients. Each returns the final message plus whatever usage the
// client reports; the tool-call record comes from the tap proxy, identically for both.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface Usage {
  /** Uncached input + cache writes + output: what the run newly paid for. */
  billable: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface ClientOut {
  finalText: string;
  usage: Usage;
  turns: number;
  costUsd?: number;
  exit: number | null;
  timedOut: boolean;
  /** Tool uses the client attempted outside the obsidian-tc server (shell, patch, ...). */
  otherTools: string[];
  model?: string;
  /** Client-side tool-discovery calls (Claude Code `ToolSearch`, Codex `tool_search`). */
  toolSearchCalls: number;
  /** Tool errors the CLIENT produced before any request reached the server (unknown / unloaded tool). */
  clientNotFound: number;
  clientNotFoundExcerpts: string[];
  raw: string;
}

/** What a client says when the model names a tool it never loaded: a not-found, not a server error. */
export const CLIENT_NOT_FOUND = /no such tool|unknown tool|tool .{0,60}not (found|available)/i;

export interface ClientCtx {
  runDir: string;
  /** Working directory for the client: an empty dir, never the vault. */
  workDir: string;
  mcpConfig: string;
  serverCmd: string[];
  tapEnv: Record<string, string>;
  prompt: string;
  /** Allow the client a shell that may run `obsidian-tc elicit` (a human approving a HITL prompt). */
  elicit: boolean;
  binDir: string;
  config: string;
  timeoutMs: number;
  model?: string;
  /** Claude Code only: keep its built-in `ToolSearch` so MCP tools are deferred as in a default install.
   *  Off (the earlier runs) loads every MCP tool definition upfront, which is NOT what users get. */
  claudeToolSearch?: boolean;
}

const zero = (): Usage => ({ billable: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

export function writeMcpConfig(c: ClientCtx): void {
  const conf = {
    mcpServers: {
      "obsidian-tc": {
        command: process.execPath,
        args: [join(import.meta.dirname, "tap-proxy.ts")],
        env: c.tapEnv,
      },
    },
  };
  writeFileSync(c.mcpConfig, JSON.stringify(conf, null, 2));
}

/** `--output-format stream-json --verbose` is one JSON event per line; the `result` event carries the
 *  same fields `--output-format json` returns. Along the way, count the client's own tool search and
 *  any tool error it produced itself (a deferred tool the model named before loading it). */
export function parseClaudeStream(stdout: string, out: ClientOut): Record<string, unknown> {
  let result: Record<string, unknown> | undefined;
  const toolNames = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e.type === "result") result = e;
    const msg = e.message as { content?: unknown } | undefined;
    if (!Array.isArray(msg?.content)) continue;
    for (const b of msg.content as Record<string, unknown>[]) {
      if (e.type === "assistant" && b.type === "tool_use") {
        toolNames.set(String(b.id), String(b.name));
        if (b.name === "ToolSearch") out.toolSearchCalls++;
      }
      if (e.type === "user" && b.type === "tool_result" && b.is_error === true) {
        const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        if (CLIENT_NOT_FOUND.test(text)) {
          out.clientNotFound++;
          out.clientNotFoundExcerpts.push(text.slice(0, 200));
        }
      }
    }
  }
  if (!result) throw new Error("no result event");
  return result;
}

export function runClaude(c: ClientCtx): ClientOut {
  writeMcpConfig(c);
  const allowed = ["mcp__obsidian-tc__*", ...(c.elicit ? ["Bash(obsidian-tc elicit:*)"] : [])];
  const args = [
    "-p",
    c.prompt,
    "--mcp-config",
    c.mcpConfig,
    "--strict-mcp-config",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    c.model ?? "sonnet",
    "--tools",
    [c.elicit ? "Bash" : "", c.claudeToolSearch ? "ToolSearch" : ""].filter(Boolean).join(","),
    "--allowedTools",
    ...allowed,
    "--setting-sources",
    "project,local",
    "--no-session-persistence",
    "--disable-slash-commands",
  ];
  const r = spawnSync("claude", args, {
    cwd: c.workDir,
    encoding: "utf8",
    timeout: c.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: `${c.binDir}:${process.env.PATH ?? ""}`,
      OBSIDIAN_TC_CONFIG: c.config,
    },
  });
  const timedOut = r.error !== undefined && /ETIMEDOUT/.test(String(r.error));
  const out: ClientOut = {
    finalText: "",
    usage: zero(),
    turns: 0,
    exit: r.status,
    timedOut,
    otherTools: [],
    toolSearchCalls: 0,
    clientNotFound: 0,
    clientNotFoundExcerpts: [],
    raw: r.stdout ?? "",
  };
  try {
    const j = parseClaudeStream(r.stdout ?? "", out);
    const u = (j.usage ?? {}) as Record<string, number>;
    out.usage = {
      input: u.input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      billable:
        (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0),
    };
    out.finalText = String(j.result ?? "");
    out.turns = Number(j.num_turns ?? 0);
    out.costUsd = typeof j.total_cost_usd === "number" ? j.total_cost_usd : undefined;
    out.model = Object.keys(j.modelUsage ?? {})[0];
    out.otherTools = ((j.permission_denials ?? []) as { tool_name?: string }[]).map(
      (d) => `denied:${d.tool_name ?? "?"}`,
    );
  } catch {
    out.finalText = `<unparseable client output: ${(r.stderr ?? "").slice(0, 300)}>`;
  }
  return out;
}

/** Populate an isolated CODEX_HOME (login + this run's config). The login is a credential: `dir` must
 *  be a private temp dir OUTSIDE the artifact tree, removed after the run (see runCodex). */
export function codexHome(dir: string, c: ClientCtx): string {
  const auth = join(dir, "auth.json");
  copyFileSync(join(homedir(), ".codex", "auth.json"), auth);
  chmodSync(auth, 0o600);
  const toml = [
    'approval_policy = "never"',
    'sandbox_mode = "workspace-write"',
    ...(c.model ? [`model = "${c.model}"`] : []),
    "[features]",
    `shell_tool = ${c.elicit}`,
    `unified_exec = ${c.elicit}`,
    "[mcp_servers.obsidian-tc]",
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(join(import.meta.dirname, "tap-proxy.ts"))}]`,
    "tool_timeout_sec = 120",
    // headless exec runs with approval_policy never, which rejects every MCP tool call that asks for a
    // client-side prompt; this is wiring, the server's own confirmation gate (HITL) is untouched.
    'default_tools_approval_mode = "approve"',
    "[mcp_servers.obsidian-tc.env]",
    ...Object.entries(c.tapEnv).map(([k, v]) => `${k} = ${JSON.stringify(v)}`),
    "",
  ].join("\n");
  writeFileSync(join(dir, "config.toml"), toml);
  return dir;
}

export function runCodex(c: ClientCtx, addDir: string): ClientOut {
  const home = mkdtempSync(join(tmpdir(), "obtc-we-codex-"));
  chmodSync(home, 0o700);
  try {
    codexHome(home, c);
    // config.toml holds no secrets (server paths and proxy env only), so it is archived with the run.
    copyFileSync(join(home, "config.toml"), join(c.runDir, "codex-config.toml"));
    return runCodexIn(c, addDir, home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function runCodexIn(c: ClientCtx, addDir: string, home: string): ClientOut {
  const last = join(c.runDir, "codex-last.txt");
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "-C",
    c.workDir,
    "--add-dir",
    addDir,
    "-o",
    last,
    c.prompt,
  ];
  const r = spawnSync("codex", args, {
    cwd: c.workDir,
    encoding: "utf8",
    timeout: c.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    input: "",
    env: {
      ...process.env,
      CODEX_HOME: home,
      PATH: `${c.binDir}:${process.env.PATH ?? ""}`,
      OBSIDIAN_TC_CONFIG: c.config,
    },
  });
  const timedOut = r.error !== undefined && /ETIMEDOUT/.test(String(r.error));
  const out: ClientOut = {
    finalText: "",
    usage: zero(),
    turns: 0,
    exit: r.status,
    timedOut,
    otherTools: [],
    toolSearchCalls: 0,
    clientNotFound: 0,
    clientNotFoundExcerpts: [],
    raw: r.stdout ?? "",
  };
  const u = zero();
  for (const line of (r.stdout ?? "").split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const e = JSON.parse(line) as {
        type?: string;
        usage?: Record<string, number>;
        item?: { type?: string; command?: string; text?: string };
      };
      if (e.type === "turn.completed" && e.usage) {
        u.input += (e.usage.input_tokens ?? 0) - (e.usage.cached_input_tokens ?? 0);
        u.cacheRead += e.usage.cached_input_tokens ?? 0;
        u.output += e.usage.output_tokens ?? 0;
        out.turns += 1;
      }
      if (
        e.type === "item.completed" &&
        e.item?.type &&
        !/mcp|agent_message|reasoning/.test(e.item.type)
      ) {
        out.otherTools.push(
          `${e.item.type}${e.item.command ? `:${e.item.command.slice(0, 80)}` : ""}`,
        );
      }
      if (e.type === "item.completed" && e.item?.type === "agent_message")
        out.finalText = e.item.text ?? out.finalText;
    } catch {
      /* non-event line */
    }
  }
  u.billable = u.input + u.cacheWrite + u.output;
  out.usage = u;
  try {
    out.finalText = readFileSync(last, "utf8") || out.finalText;
  } catch {
    /* codex wrote no last message */
  }
  if (!out.finalText && /usage limit/i.test(out.raw)) out.finalText = "<codex usage limit>";
  return out;
}
