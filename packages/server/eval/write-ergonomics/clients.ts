// Headless drivers for the two real clients. Each returns the final message plus whatever usage the
// client reports; the tool-call record comes from the tap proxy, identically for both.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
  raw: string;
}

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
    "json",
    "--model",
    c.model ?? "sonnet",
    "--tools",
    c.elicit ? "Bash" : "",
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
    raw: r.stdout ?? "",
  };
  try {
    const j = JSON.parse(r.stdout) as Record<string, unknown>;
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
    out.model = Object.keys((j.modelUsage ?? {}) as object)[0];
    out.otherTools = ((j.permission_denials ?? []) as { tool_name?: string }[]).map(
      (d) => `denied:${d.tool_name ?? "?"}`,
    );
  } catch {
    out.finalText = `<unparseable client output: ${(r.stderr ?? "").slice(0, 300)}>`;
  }
  return out;
}

/** An isolated CODEX_HOME holding only the copied login and this run's config. */
export function codexHome(dir: string, c: ClientCtx): string {
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(homedir(), ".codex", "auth.json"), join(dir, "auth.json"));
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
    "[mcp_servers.obsidian-tc.env]",
    ...Object.entries(c.tapEnv).map(([k, v]) => `${k} = ${JSON.stringify(v)}`),
    "",
  ].join("\n");
  writeFileSync(join(dir, "config.toml"), toml);
  return dir;
}

export function runCodex(c: ClientCtx, addDir: string): ClientOut {
  const home = codexHome(join(c.runDir, "codex-home"), c);
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
