// THE-208: local plur bridge. plur ships no HTTP read-API — it is a CLI + stdio-MCP server over a
// local YAML engram store (~/.plur). The HTTP proxy in client.ts targets an endpoint that only a
// (sales-gated) PLUR Enterprise deployment would expose, so those tools are otherwise dormant. This
// backend reaches the LOCAL plur the operator actually runs by shelling out to its READ-ONLY CLI
// verbs (recall / similarity-search / list) via execFile — no shell, so the query is a plain argv
// element and cannot inject. It implements the same request({path,body}) surface as the HTTP
// BridgeClient, so the M5 plur tools stay transport-agnostic. No write verb (learn/forget/capture)
// is ever invoked.
import { execFile } from "node:child_process";
import { err } from "@the-40-thieves/obsidian-tc-shared";
import type { BridgeClient, BridgeRequest } from "../bridge/transport";

export interface PlurExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type PlurExec = (argv: string[]) => Promise<PlurExecResult>;

/** execFile the configured plur CLI (command[0] + any prefix args), no shell. */
export function createDefaultExec(command: string[], timeoutMs: number): PlurExec {
  const bin = command[0] as string;
  const prefix = command.slice(1);
  return (argv) =>
    new Promise((resolve) => {
      execFile(
        bin,
        [...prefix, ...argv],
        { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          const errCode = (error as { code?: unknown } | null)?.code;
          const code = typeof errCode === "number" ? errCode : error ? 1 : 0;
          resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
        },
      );
    });
}

export interface LocalPlurConfig {
  command: string[];
  timeoutMs?: number;
  /** Injected for tests; defaults to a real execFile runner. */
  exec?: PlurExec;
}

type Obj = Record<string, unknown>;

/** Parse the CLI's --json stdout. plur uses exit 2 for "no results" (with valid JSON), so the
 *  exit code is not treated as failure; only unparseable output or an {error} field degrades. */
function parseOut(r: PlurExecResult): Obj {
  const text = (r.stdout || r.stderr || "").trim();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw err.pluginUnreachable("plur CLI returned non-JSON output", { plugin: "plur" });
  }
  if (typeof data !== "object" || data === null)
    throw err.pluginUnreachable("plur CLI returned an unexpected shape", { plugin: "plur" });
  if ("error" in (data as Obj))
    throw err.pluginUnreachable("plur CLI reported an error", { plugin: "plur" });
  return data as Obj;
}

function requireStr(body: Obj, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || v.length === 0)
    throw err.invalidInput(`plur request missing ${key}`, { plugin: "plur" });
  return v;
}
function numOr(body: Obj, key: string, dflt: number): number {
  const v = body[key];
  return typeof v === "number" ? v : dflt;
}

/** A plur read client that maps the M5 tool request paths onto the local plur CLI. */
export function createLocalPlurClient(cfg: LocalPlurConfig): Pick<BridgeClient, "request"> {
  const timeoutMs = cfg.timeoutMs ?? 5000;
  const exec = cfg.exec ?? createDefaultExec(cfg.command, timeoutMs);

  // plur recall: default is hybrid (recallHybrid); --fast selects pure BM25 (recall). That maps
  // obsidian-tc's plur_recall (BM25) -> --fast and plur_recall_hybrid -> default exactly.
  const recall = async (body: Obj, hybrid: boolean): Promise<Obj> => {
    const query = requireStr(body, "query");
    const k = numOr(body, "k", 10);
    const argv = ["recall", query, "--limit", String(k), "--json"];
    if (!hybrid) argv.push("--fast");
    const out = parseOut(await exec(argv));
    let results = Array.isArray(out.results) ? (out.results as Obj[]) : [];
    // recall has no --scope flag; honor the arg by filtering the returned engrams' scope.
    const scope = typeof body.scope === "string" ? body.scope : undefined;
    if (scope) results = results.filter((e) => e.scope === scope);
    return { results, count: results.length };
  };

  const similarity = async (body: Obj): Promise<Obj> => {
    const query = requireStr(body, "query");
    const k = numOr(body, "k", 10);
    const argv = ["similarity-search", query, "--limit", String(k), "--json"];
    const scope = typeof body.scope === "string" ? body.scope : undefined;
    if (scope) argv.push("--scope", scope);
    const out = parseOut(await exec(argv));
    let results = Array.isArray(out.results) ? (out.results as Obj[]) : [];
    const minScore = typeof body.min_score === "number" ? body.min_score : undefined;
    if (minScore !== undefined)
      results = results.filter(
        (e) => typeof e.cosine_score === "number" && (e.cosine_score as number) >= minScore,
      );
    return { results, count: results.length };
  };

  // plur has no `get <id>`; list all and filter (the local store is small).
  const get = async (body: Obj): Promise<Obj> => {
    const id = requireStr(body, "engram_id");
    const out = parseOut(await exec(["list", "--json"]));
    const engrams = Array.isArray(out.engrams)
      ? (out.engrams as Obj[])
      : Array.isArray(out.results)
        ? (out.results as Obj[])
        : [];
    const engram = engrams.find((e) => e.id === id) ?? null;
    return { found: engram !== null, engram };
  };

  return {
    request<T>(r: BridgeRequest): Promise<T> {
      const body = (r.body ?? {}) as Obj;
      switch (r.path) {
        case "/recall":
          return recall(body, false) as Promise<T>;
        case "/recall_hybrid":
          return recall(body, true) as Promise<T>;
        case "/similarity_search":
          return similarity(body) as Promise<T>;
        case "/get":
          return get(body) as Promise<T>;
        default:
          return Promise.reject(
            err.pluginUnreachable("unsupported plur operation", { plugin: "plur", path: r.path }),
          );
      }
    },
  };
}
