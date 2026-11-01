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
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { type ParseError, parse } from "jsonc-parser/lib/esm/main.js";
import type { RestApiOnDisk } from "../bridge";
import { claudeDesktopConfigPath, cursorMcpConfigPath } from "../cli/setup/client-install";
import { sanitizeClientName } from "../hitl-telemetry";
import { canonicalizeVaultRootWithStatus } from "../vault/registry";
import type { Check, CheckResult } from "./types";

/** What reading one client config file came to. `absent` is a file that does not exist. */
export type ConfigFileRead =
  | { kind: "text"; text: string }
  | { kind: "absent" }
  | { kind: "not-a-file" }
  | { kind: "too-large" };

/** Every filesystem read this check makes, injected so a test never touches a real home directory.
 *  `readFile` reports what it found and throws for any other failure; `realpath` returns undefined
 *  for a path that does not exist. */
export interface SameVaultRootIo {
  readFile: (path: string) => ConfigFileRead;
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

/** A client config is a small JSON file; anything bigger is refused rather than read. */
const CONFIG_MAX_BYTES = 1024 * 1024;

/** The real filesystem. A missing file or directory is simply absent, not an error. The file is
 *  opened non-blocking and checked with fstat before any read: a FIFO or a device (`/dev/tty`,
 *  `/dev/zero`) would otherwise block the read, and no client config is one. */
export function nodeSameVaultRootIo(): SameVaultRootIo {
  return {
    readFile: (path) => {
      let fd: number;
      try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
        throw err;
      }
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) return { kind: "not-a-file" };
        if (st.size > CONFIG_MAX_BYTES) return { kind: "too-large" };
        return { kind: "text", text: readFileSync(fd, "utf8") };
      } finally {
        closeSync(fd);
      }
    },
    // The vault registry's realpath (realpath.native, lexical fallback; THE-657), so a root is
    // spelled the same way here as everywhere else. Undefined when the path does not exist.
    realpath: (path) => {
      const { root, canonical } = canonicalizeVaultRootWithStatus(path);
      return canonical ? root : undefined;
    },
    home: homedir(),
    cwd: process.cwd(),
    platform: process.platform,
    env: process.env,
  };
}

const NOT_COMPARED = [
  "not read: the Codex config (TOML, not read) and every other MCP client's config",
  "not compared: remote servers, which have no local path",
  "a server that uses the Local REST API carries no vault path, so it is listed under unverifiable, never matched",
  "another obsidian-tc instance with its own --config is listed under unverifiable: its roots are not in this process",
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
  // `..foo` is a directory inside the root, not a climb: only `..` itself, or `../…`, climbs out.
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel);
}

/** A leading `~` expands to the home directory. Only an absolute result is comparable: a relative
 *  argument names nothing this check can resolve. */
function absolutePath(raw: string, home: string, p: typeof posix): string | undefined {
  const expanded =
    raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\") ? p.join(home, raw.slice(1)) : raw;
  return p.isAbsolute(expanded) ? p.normalize(expanded) : undefined;
}

/** A candidate that names a network or device location is never handed to realpath: on win32 a UNC
 *  or device path (`\\host\share`, `\\.\pipe\x`, `//host/...`), and on darwin `/net/<host>`, can make
 *  realpath open an SMB share or an autofs mount. Doctor is offline by construction, so these are not
 *  compared at all. */
function isNetworkOrDevicePath(raw: string, platform: NodeJS.Platform): boolean {
  if (raw.startsWith("\\\\") || raw.startsWith("//")) return true;
  return platform === "darwin" && (raw === "/net" || raw.startsWith("/net/"));
}

/** The realpath of a candidate, or undefined when it is not comparable: relative once expanded, a
 *  network or device location, missing, or a realpath that is not absolute (`pipe:[N]` for a
 *  /proc/self/fd entry). */
function candidateRealpath(io: SameVaultRootIo, raw: string): string | undefined {
  const p = pathsFor(io.platform);
  const abs = absolutePath(raw, io.home, p);
  if (abs === undefined) return undefined;
  if (isNetworkOrDevicePath(raw, io.platform) || isNetworkOrDevicePath(abs, io.platform)) {
    return undefined;
  }
  const real = io.realpath(abs);
  return real !== undefined && p.isAbsolute(real) ? real : undefined;
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
  let read: ConfigFileRead;
  try {
    read = io.readFile(src.path);
  } catch {
    notes.push(`${src.label}: config file could not be read; its servers were not compared`);
    return undefined;
  }
  if (read.kind === "absent") return undefined;
  if (read.kind !== "text") {
    const why = read.kind === "too-large" ? "is larger than 1 MiB" : "is not a regular file";
    notes.push(`${src.label}: config file ${why}; its servers were not compared`);
    return undefined;
  }
  const errors: ParseError[] = [];
  const data = asObject(parse(read.text, errors, { allowTrailingComma: true }));
  if (data === undefined || errors.length > 0) {
    notes.push(`${src.label}: config file is not valid JSON; its servers were not compared`);
    return undefined;
  }
  const entries: [string, unknown][] = Object.entries(asObject(data.mcpServers) ?? {});
  if (src.projectCwd !== undefined) {
    // projects[<cwd>] is keyed by the cwd as written, so try it with and without a trailing separator.
    const bare = src.projectCwd.replace(/[\\/]+$/, "");
    const projects = asObject(data.projects) ?? {};
    const sep = pathsFor(io.platform).sep;
    for (const key of new Set([src.projectCwd, bare, `${bare}${sep}`])) {
      entries.push(...Object.entries(asObject(asObject(projects[key])?.mcpServers) ?? {}));
    }
  }
  return entries;
}

/** Adds `value` unless it is already listed: one server reached through two sources is one line. */
function addOnce(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
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

/** True when an obsidian-tc entry is this server: its `--config` names the config this run loaded, or
 *  a positional argument names one of this run's vault roots (the zero-config `obsidian-tc <vault>`,
 *  which loads no file). Compared after realpath, case-folded where the platform folds. */
function isThisServer(
  ctx: ScanCtx,
  args: readonly string[],
  configArg: string | undefined,
): boolean {
  const { io } = ctx;
  const same = (a: string, b: string) => foldCase(io.platform, a) === foldCase(io.platform, b);
  const configReal = configArg === undefined ? undefined : candidateRealpath(io, configArg);
  if (configReal !== undefined && ctx.selfReal !== undefined) {
    if (same(configReal, ctx.selfReal)) return true;
  }
  return args.some((arg) => {
    if (arg.startsWith("-")) return false;
    const real = candidateRealpath(io, arg);
    return real !== undefined && ctx.roots.some((root) => same(root, real));
  });
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
  const candidates = [
    ...args,
    ...args
      .filter((a) => a.startsWith("-") && a.includes("="))
      .map((a) => a.slice(a.indexOf("=") + 1)),
    ...envValues,
  ];
  return candidates.some((candidate) => {
    const real = candidateRealpath(io, candidate);
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

  const obsidianTc = `${command} ${args.join(" ")}`.includes("obsidian-tc");
  if (obsidianTc && isThisServer(ctx, args, configArg)) return;
  if (usesRestApi(envObject, args)) {
    const enabled =
      ctx.restEnabled.length > 0
        ? `; Local REST API is enabled on vault ${ctx.restEnabled.join(", ")}`
        : "";
    addOnce(ctx.out.unverifiable, `${ref}: Local REST API, vault not comparable${enabled}`);
    return;
  }
  // Another obsidian-tc instance on a different config: its roots are not in this process.
  if (obsidianTc && configArg !== undefined) {
    addOnce(ctx.out.unverifiable, `${ref}: another obsidian-tc instance, roots not compared`);
    return;
  }
  if (pointsAtRoot(ctx, args, envValues)) addOnce(ctx.out.sameRoot, ref);
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
  // Two sources can be one file (with cwd at home, the project's .cursor/mcp.json is the user one):
  // it is read once. The key is sanitised here, so no output can carry a raw escape or a path.
  const seen = new Set<string>();
  for (const src of clientSources(io)) {
    const real = io.realpath(src.path) ?? src.path;
    if (seen.has(real)) continue;
    seen.add(real);
    const servers = readServers(io, src, ctx.out.notes);
    if (servers === undefined) continue;
    if (!ctx.out.scanned.includes(src.label)) ctx.out.scanned.push(src.label);
    for (const [key, raw] of servers) {
      classifyEntry(ctx, `${src.label}:${sanitizeClientName(key) ?? "(key omitted)"}`, raw);
    }
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
      if (view.vaults.length === 0) {
        return { status: "ok", summary: "no vault roots are configured; nothing to compare" };
      }
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
