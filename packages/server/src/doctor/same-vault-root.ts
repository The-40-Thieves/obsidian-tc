// clients.sameVaultRoot — does another MCP server, defined in an MCP client's own config file, point
// at one of this install's configured vault roots?
//
// An agent with two servers on one vault can split its reads between them, and the operator often
// does not know the second server is configured. Neither doctor nor server_health can see another
// server, so this reads the client config files on disk and names the matching server KEYS only.
// A path is never printed: the summary, details and notes carry client labels and server keys.
//
// Its own module rather than more of checks.ts, same reasoning as capture-location.ts: a
// self-contained scanner that has to stay under biome's 700-line ceiling. It is a HINT, so it
// always reports `ok`: a second server on one vault is not an error, and a wrong guess here must
// not turn the doctor red.
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { type ParseError, parse } from "jsonc-parser/lib/esm/main.js";
import type { RestApiOnDisk } from "../bridge";
import { claudeDesktopConfigPath, cursorMcpConfigPath } from "../cli/setup/client-install";
import type { Check, CheckResult } from "./types";

/** Every filesystem read this check makes, injected so a test never touches a real home directory.
 *  `readFile` returns undefined for a file that does not exist and throws for any other failure;
 *  `realpath` returns undefined for a path that does not exist. */
export interface SameVaultRootIo {
  readFile: (path: string) => string | undefined;
  realpath: (path: string) => string | undefined;
  home: string;
  cwd: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
}

export interface SameVaultRootView {
  vaults: readonly { id: string; path: string }[];
  /** Local REST API plugin state on disk for a vault path (doctor's `restApiOnDisk`). Only used to
   *  name the vaults the REST API is enabled on, in the unverifiable note. */
  restApiOnDisk?: ((vaultPath: string) => RestApiOnDisk | undefined) | undefined;
  /** The config this run loaded (`cmd.configPath`). An entry that loads the same file is this
   *  server itself and is skipped. */
  configPath?: string | undefined;
  io: SameVaultRootIo;
}

/** The real filesystem. A missing file or directory is simply absent, not an error. */
export function nodeSameVaultRootIo(): SameVaultRootIo {
  return {
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return undefined;
        throw err;
      }
    },
    realpath: (path) => {
      try {
        return realpathSync.native(path);
      } catch {
        return undefined;
      }
    },
    home: homedir(),
    cwd: process.cwd(),
    platform: process.platform,
    env: process.env,
  };
}

const NOT_COMPARED = [
  "not read: Codex (~/.codex/config.toml; this build has no TOML parser) and every other MCP client's config",
  "not compared: remote servers, which have no local path",
  "a server that uses the Local REST API carries no vault path, so it is listed under unverifiable, never matched",
  "another obsidian-tc instance points at a config file, not a vault root, so it is listed under unverifiable",
  "this is a hint about the config files found, not a guarantee: a server defined anywhere else is invisible here",
];

const REMEDIATION =
  "Agents can split reads between servers on one vault, so one agent may see only part of it. Remove the duplicate entry, or scope it to a different vault.";

interface ClientSource {
  label: string;
  path: string;
  /** Claude Code's ~/.claude.json also keeps servers per project, under projects[<cwd>]. */
  projectCwd?: string;
}

interface Scan {
  sameRoot: string[];
  unverifiable: string[];
  scanned: string[];
  notes: string[];
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function pathsFor(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/** Case folds on win32 and darwin only: those filesystems are case-insensitive by default. */
function foldCase(platform: NodeJS.Platform, s: string): string {
  return platform === "win32" || platform === "darwin" ? s.toLowerCase() : s;
}

/** True when `dir` is `root` itself, or nested inside it. Same containment idiom as
 *  capture-location.ts: the relative path must not climb out and must not come back absolute. */
function isInside(root: string, dir: string, platform: NodeJS.Platform): boolean {
  const p = pathsFor(platform);
  const r = foldCase(platform, p.normalize(root));
  const d = foldCase(platform, p.normalize(dir));
  if (r === d) return true;
  const rel = p.relative(r, d);
  return rel !== "" && !rel.startsWith("..") && !p.isAbsolute(rel);
}

/** A leading `~` expands to the home directory. Only an absolute result is comparable: a relative
 *  argument names nothing this check can resolve. */
function absolutePath(raw: string, home: string, p: typeof posix): string | undefined {
  const expanded =
    raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\") ? p.join(home, raw.slice(1)) : raw;
  return p.isAbsolute(expanded) ? p.normalize(expanded) : undefined;
}

/** The value of `--config <p>` or `--config=<p>`, when the args carry one. */
function configArgOf(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg.startsWith("--config=")) return arg.slice("--config=".length);
    if (arg === "--config" && args[i + 1] !== undefined) return args[i + 1];
  }
  return undefined;
}

function clientSources(io: SameVaultRootIo): ClientSource[] {
  const p = pathsFor(io.platform);
  return [
    { label: "claude-code", path: p.join(io.home, ".claude.json"), projectCwd: io.cwd },
    { label: "claude-code", path: p.join(io.cwd, ".mcp.json") },
    { label: "cursor", path: cursorMcpConfigPath(io.home) },
    { label: "cursor", path: p.join(io.cwd, ".cursor", "mcp.json") },
    { label: "claude-desktop", path: claudeDesktopConfigPath(io.platform, io.env, io.home) },
  ];
}

/** The `[key, entry]` pairs one client config file defines, or undefined when the file is absent,
 *  unreadable or unparseable (the last two add a note naming the client, never the path). */
function readServers(
  io: SameVaultRootIo,
  src: ClientSource,
  notes: string[],
): [string, unknown][] | undefined {
  let text: string | undefined;
  try {
    text = io.readFile(src.path);
  } catch {
    notes.push(`${src.label}: config file could not be read; its servers were not compared`);
    return undefined;
  }
  if (text === undefined) return undefined;
  const errors: ParseError[] = [];
  const data = asObject(parse(text, errors, { allowTrailingComma: true }));
  if (data === undefined || errors.length > 0) {
    notes.push(`${src.label}: config file is not valid JSON; its servers were not compared`);
    return undefined;
  }
  const entries: [string, unknown][] = Object.entries(asObject(data.mcpServers) ?? {});
  if (src.projectCwd !== undefined) {
    const project = asObject(asObject(data.projects)?.[src.projectCwd]);
    entries.push(...Object.entries(asObject(project?.mcpServers) ?? {}));
  }
  return entries;
}

interface ScanCtx {
  io: SameVaultRootIo;
  /** Realpath of the config this run loaded, when known. */
  selfReal: string | undefined;
  /** Realpaths of the configured vault roots (the literal path when a root does not exist). */
  roots: readonly string[];
  restEnabled: readonly string[];
  out: Scan;
}

/** True when the entry's `--config` names the config this run loaded: this server itself. */
function isThisServer(ctx: ScanCtx, configArg: string | undefined): boolean {
  if (configArg === undefined) return false;
  const target = absolutePath(configArg, ctx.io.home, pathsFor(ctx.io.platform));
  const real = target === undefined ? undefined : ctx.io.realpath(target);
  return real !== undefined && real === ctx.selfReal;
}

/** Local REST API: the entry carries an API key or the REST port, and never a vault path. */
function usesRestApi(envObject: Json, args: readonly string[]): boolean {
  return "OBSIDIAN_API_KEY" in envObject || args.some((a) => /2712[34]/.test(a));
}

/** Candidate paths are each arg, the right-hand side of `--flag=value`, and each env value. */
function pointsAtRoot(
  ctx: ScanCtx,
  args: readonly string[],
  envValues: readonly string[],
): boolean {
  const { io } = ctx;
  const p = pathsFor(io.platform);
  const candidates = [
    ...args,
    ...args
      .filter((a) => a.startsWith("-") && a.includes("="))
      .map((a) => a.slice(a.indexOf("=") + 1)),
    ...envValues,
  ];
  return candidates.some((candidate) => {
    const abs = absolutePath(candidate, io.home, p);
    const real = abs === undefined ? undefined : io.realpath(abs);
    return real !== undefined && ctx.roots.some((root) => isInside(root, real, io.platform));
  });
}

/** Sorts one server entry into: this server (skipped), unverifiable, a root match, or no match. */
function classifyEntry(ctx: ScanCtx, ref: string, raw: unknown): void {
  const entry = asObject(raw);
  if (entry === undefined) return;
  const args = Array.isArray(entry.args)
    ? entry.args.filter((a): a is string => typeof a === "string")
    : [];
  const envObject = asObject(entry.env) ?? {};
  const envValues = Object.values(envObject).filter((v): v is string => typeof v === "string");
  const command = typeof entry.command === "string" ? entry.command : "";
  const configArg = configArgOf(args);

  if (isThisServer(ctx, configArg)) return;
  if (usesRestApi(envObject, args)) {
    const enabled =
      ctx.restEnabled.length > 0
        ? `; Local REST API is enabled on vault ${ctx.restEnabled.join(", ")}`
        : "";
    ctx.out.unverifiable.push(`${ref}: Local REST API, vault not comparable${enabled}`);
    return;
  }
  // Another obsidian-tc instance on a different config: its roots are not in this process.
  if (`${command} ${args.join(" ")}`.includes("obsidian-tc") && configArg !== undefined) {
    ctx.out.unverifiable.push(`${ref}: another obsidian-tc instance, roots not compared`);
    return;
  }
  if (pointsAtRoot(ctx, args, envValues)) ctx.out.sameRoot.push(ref);
}

function scan(view: SameVaultRootView): Scan {
  const { io } = view;
  const ctx: ScanCtx = {
    io,
    selfReal: view.configPath === undefined ? undefined : io.realpath(view.configPath),
    roots: view.vaults.map((v) => io.realpath(v.path) ?? v.path),
    restEnabled: view.vaults
      .filter((v) => view.restApiOnDisk?.(v.path) === "enabled")
      .map((v) => v.id),
    out: { sameRoot: [], unverifiable: [], scanned: [], notes: [] },
  };
  for (const src of clientSources(io)) {
    const servers = readServers(io, src, ctx.out.notes);
    if (servers === undefined) continue;
    if (!ctx.out.scanned.includes(src.label)) ctx.out.scanned.push(src.label);
    for (const [key, raw] of servers) classifyEntry(ctx, `${src.label}:${key}`, raw);
  }
  ctx.out.notes.push(...NOT_COMPARED);
  return ctx.out;
}

/**
 * clients.sameVaultRoot — names other MCP servers, by client label and server key, whose arguments
 * or environment point at a configured vault root. Always `ok`: see the module comment. Never
 * throws: a failed scan is reported as a note, the same as any single unreadable file.
 */
export function sameVaultRootCheck(view: SameVaultRootView): Check {
  return {
    id: "clients.sameVaultRoot",
    category: "config",
    run: (): CheckResult => {
      let found: Scan;
      try {
        found = scan(view);
      } catch {
        return {
          status: "ok",
          summary: "could not scan MCP client configs for a second server on a vault root",
          notes: NOT_COMPARED,
        };
      }
      const { sameRoot, unverifiable, scanned, notes } = found;
      const details = { sameRoot, unverifiable, scanned };
      if (sameRoot.length === 0) {
        return {
          status: "ok",
          summary: `no other MCP server in ${scanned.length} client configs points at a configured vault root`,
          details,
          notes,
        };
      }
      return {
        status: "ok",
        summary: `${sameRoot.length} other MCP server(s) point at a configured vault root: ${sameRoot.join(", ")}`,
        details,
        notes,
        remediation: REMEDIATION,
      };
    },
  };
}
