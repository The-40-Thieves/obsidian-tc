// Obsidian Git (THE-378, WP6.1 extraction from routes.ts). The git plugin exposes no stable
// `api`, so every method is probed before use and absence degrades, never throws. Every git
// operation is wrapped so a git failure comes back as git_error, never a 500.
import { realpathSync } from "node:fs";
import { body, fail, ok, str } from "./envelope";
import {
  type BridgeRes,
  type CommunityPlugin,
  communityPlugin,
  type InternalApp,
  type RouteDef,
} from "./types";

// Duck-typed view of obsidian-git's gitManager — it exposes no stable `api`, so every method is
// probed before use and absence degrades, never throws.
interface GitManagerLite {
  status?: () => Promise<unknown>;
  absoluteRepoPath?: unknown;
  git?: { revparse?: (args: string[]) => Promise<unknown> };
  getDiffString?: (path: string, staged?: boolean) => Promise<unknown>;
  log?: (file: undefined, relativeToVault: boolean, limit: number) => Promise<unknown>;
  stage?: (path: string, relativeToVault: boolean) => Promise<unknown>;
  commit?: (opts: { message: string }) => Promise<unknown>;
}

interface GitStatusRow {
  path?: string;
  from?: string;
  workingDir?: string;
  working_dir?: string;
  index?: string;
}

type VaultPathMapper = (path: string) => string | null;

interface GitPathMappers {
  toVaultPath: VaultPathMapper;
  toRepoPath: VaultPathMapper;
  nativeGitPathspecs: boolean;
}

interface ParsedAbsolutePath {
  root: string;
  segments: string[];
}

/** Case folds only where the platform's filesystem does; Linux stays exact. */
function foldsCase(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32";
}

/**
 * Comparison key for one segment. NFC always, because git and the disk can disagree on Unicode
 * form (NFD folder names on macOS); the mapped output keeps each segment's own spelling.
 */
function segmentKey(segment: string, caseInsensitive: boolean): string {
  const nfc = segment.normalize("NFC");
  return caseInsensitive ? nfc.toLowerCase() : nfc;
}

/** Resolve symlinks and junctions; an unresolvable path keeps its spelling, never throws. */
function canonicalPath(path: unknown): unknown {
  if (typeof path !== "string") return path;
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function relativeSegments(path: string, allowEmpty = false): string[] | null {
  if (path.includes("\\") || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:/.test(path))
    return null;
  if (path === "" && allowEmpty) return [];
  const segments = path.split("/");
  return segments.length > 0 &&
    segments.every((part) => part !== "" && part !== "." && part !== "..")
    ? segments
    : null;
}

function absolutePath(path: unknown): ParsedAbsolutePath | null {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) return null;
  const normalized = path.replace(/\\/g, "/");
  const drive = /^([A-Za-z]:)\/(.*)$/.exec(normalized);
  const posix = normalized.startsWith("/");
  if (!drive && !posix) return null;
  const driveRoot = drive?.[1];
  const driveRest = drive?.[2];
  if (drive && (driveRoot === undefined || driveRest === undefined)) return null;
  const root = driveRoot?.toLowerCase() ?? "/";
  const rawSegments = (driveRest ?? normalized.slice(1)).split("/");
  const segments: string[] = [];
  for (const part of rawSegments) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  return { root, segments };
}

function startsWithPath(
  path: ParsedAbsolutePath,
  parent: ParsedAbsolutePath,
  caseInsensitive: boolean,
): boolean {
  if (path.root !== parent.root) return false;
  if (parent.segments.length > path.segments.length) return false;
  return parent.segments.every((part, index) => {
    const candidate = path.segments[index];
    if (candidate === undefined) return false;
    return segmentKey(candidate, caseInsensitive) === segmentKey(part, caseInsensitive);
  });
}

function desktopPathMappers(
  repositoryPath: unknown,
  vaultPath: unknown,
  platform: NodeJS.Platform,
): GitPathMappers | null {
  // Canonicalise first: a vault reached through a symlink or junction compares as its real place.
  const repository = absolutePath(canonicalPath(repositoryPath));
  const vault = absolutePath(canonicalPath(vaultPath));
  if (!repository || !vault) return null;
  const startsWith = (path: ParsedAbsolutePath, parent: ParsedAbsolutePath) =>
    startsWithPath(path, parent, foldsCase(platform));
  if (!startsWith(repository, vault) && !startsWith(vault, repository)) return null;
  return {
    nativeGitPathspecs: true,
    toVaultPath: (path) => {
      const rel = relativeSegments(path);
      if (!rel) return null;
      const file: ParsedAbsolutePath = {
        ...repository,
        segments: [...repository.segments, ...rel],
      };
      if (!startsWith(file, vault)) return null;
      const mapped = file.segments.slice(vault.segments.length);
      return mapped.length > 0 ? mapped.join("/") : null;
    },
    toRepoPath: (path) => {
      const rel = relativeSegments(path);
      if (!rel) return null;
      const file: ParsedAbsolutePath = {
        ...vault,
        segments: [...vault.segments, ...rel],
      };
      if (!startsWith(file, repository)) return null;
      const mapped = file.segments.slice(repository.segments.length);
      return mapped.length > 0 ? mapped.join("/") : null;
    },
  };
}

function settingsBasePath(app: InternalApp): string | undefined {
  const settings = communityPlugin(app, "git")?.settings;
  if (typeof settings !== "object" || settings === null) return undefined;
  if (!Object.hasOwn(settings, "basePath")) return undefined;
  const basePath = (settings as { basePath?: unknown }).basePath;
  return typeof basePath === "string" ? basePath : undefined;
}

function gitPathMappers(
  app: InternalApp,
  gm: GitManagerLite,
  platform: NodeJS.Platform,
): { mappers?: GitPathMappers; reason?: string; hint?: string } {
  const adapter = app.vault.adapter as unknown as { getBasePath?: () => unknown };
  if (typeof gm.absoluteRepoPath === "string") {
    if (typeof adapter.getBasePath !== "function")
      return {
        reason: "obsidian-git cannot determine the vault base path",
        hint: "Update Obsidian and obsidian-git, then retry",
      };
    let vaultPath: unknown;
    try {
      vaultPath = adapter.getBasePath();
    } catch {
      return {
        reason: "obsidian-git cannot determine the vault base path",
        hint: "Update Obsidian and obsidian-git, then retry",
      };
    }
    const mappers = desktopPathMappers(gm.absoluteRepoPath, vaultPath, platform);
    return mappers
      ? { mappers }
      : {
          reason: "obsidian-git cannot determine the repo-to-vault offset",
          hint: "Check the configured repository location and update obsidian-git",
        };
  }

  if (typeof adapter.getBasePath === "function")
    return {
      reason: "this obsidian-git version does not expose the desktop repository path",
      hint: "Update obsidian-git to version 2.28.0 or newer",
    };

  const basePath = settingsBasePath(app);
  if (basePath === undefined)
    return {
      reason: "obsidian-git cannot determine the mobile repo-to-vault offset",
      hint: "Update obsidian-git, then retry",
    };
  const prefix = relativeSegments(basePath, true);
  if (!prefix)
    return {
      reason: "obsidian-git reported an invalid vault-relative basePath",
      hint: "Correct the obsidian-git base path setting",
    };
  return {
    mappers: {
      nativeGitPathspecs: false,
      toVaultPath: (path) => {
        const rel = relativeSegments(path);
        return rel ? [...prefix, ...rel].join("/") : null;
      },
      toRepoPath: (path) => {
        const rel = relativeSegments(path);
        if (!rel || prefix.some((part, index) => rel[index] !== part)) return null;
        const mapped = rel.slice(prefix.length);
        return mapped.length > 0 ? mapped.join("/") : null;
      },
    },
  };
}

async function requireGitPathMappers(
  app: InternalApp,
  gm: GitManagerLite,
  res: BridgeRes,
  platform: NodeJS.Platform,
): Promise<GitPathMappers | null> {
  const result = gitPathMappers(app, gm, platform);
  if (!result.mappers) {
    fail(res, "plugin_incompatible", result.reason ?? "unknown git path basis", {
      plugin: "git",
      ...(result.hint ? { hint: result.hint } : {}),
    });
    return null;
  }
  const git = gm.git;
  if (typeof gm.absoluteRepoPath === "string" && typeof git?.revparse === "function") {
    // On a settings reload obsidian-git first points absoluteRepoPath and its git instance at the
    // base path, then moves both to the repository root found by `--show-cdup`. Status rows are
    // root-relative, so mapping them before that move would read them against the wrong folder.
    // A non-empty cdup means the instance does not sit at the root yet. It is relative, so it
    // works when git runs in another filesystem (WSL), where an absolute toplevel would not.
    let cdup: unknown;
    try {
      cdup = await git.revparse(["--show-cdup"]);
    } catch (e) {
      fail(res, "git_error", e instanceof Error ? e.message : String(e));
      return null;
    }
    if (typeof cdup !== "string" || cdup.trim() !== "") {
      fail(res, "git_error", "the repository is being reconfigured in obsidian-git; retry shortly");
      return null;
    }
  }
  return result.mappers;
}

function safeRepoPath(path: unknown, mappers: GitPathMappers): string | null {
  const mapped = mapVaultPath(path, mappers.toRepoPath);
  if (!mapped) return null;
  return mappers.nativeGitPathspecs ? `:(literal)${mapped}` : mapped;
}

/** Convert one repository-relative path and reject results outside the vault. */
function mapVaultPath(path: unknown, toVaultPath: VaultPathMapper): string | null {
  if (typeof path !== "string" || path.length === 0) return null;
  const rel = toVaultPath(path);
  if (
    typeof rel !== "string" ||
    rel.length === 0 ||
    rel.includes("\\") ||
    rel.includes("\0") ||
    rel.startsWith("/") ||
    /^[A-Za-z]:/.test(rel) ||
    rel.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    return null;
  return rel;
}

/** Map all path-bearing fields together; an unsafe rename source drops the whole row. */
function mapStatusPaths(
  row: GitStatusRow,
  toVaultPath: VaultPathMapper,
): { path: string; from?: string } | null {
  const path = mapVaultPath(row.path, toVaultPath);
  if (!path) return null;
  const from = row.from === undefined ? undefined : mapVaultPath(row.from, toVaultPath);
  if (from === null) return null;
  return { path, ...(from === undefined ? {} : { from }) };
}

/** Resolve obsidian-git's gitManager, mapping absence onto the error taxonomy. */
function gitManagerOf(app: InternalApp, res: BridgeRes): GitManagerLite | null {
  const plugin = communityPlugin(app, "git");
  if (!plugin) {
    fail(res, "plugin_missing", "obsidian-git is not installed", { plugin: "git" });
    return null;
  }
  // gitManager is obsidian-git-specific — not part of the shared CommunityPlugin shape other
  // families duck-type from — so it is cast locally, only once `plugin` is known defined.
  const gitManager = (plugin as CommunityPlugin & { gitManager?: GitManagerLite }).gitManager;
  if (!gitManager) {
    fail(res, "plugin_unreachable", "obsidian-git exposes no gitManager", { plugin: "git" });
    return null;
  }
  return gitManager;
}

export function buildGitRoutes(
  app: InternalApp,
  platform: NodeJS.Platform = process.platform,
): RouteDef[] {
  return [
    {
      method: "post",
      path: "/git/status",
      handler: async (_req, res) => {
        const gm = gitManagerOf(app, res);
        if (!gm) return;
        if (typeof gm.status !== "function")
          return fail(res, "plugin_unreachable", "obsidian-git exposes no status()", {
            plugin: "git",
          });
        const pathMappers = await requireGitPathMappers(app, gm, res, platform);
        if (!pathMappers) return;
        try {
          const { toVaultPath } = pathMappers;
          const s = (await gm.status()) as {
            changed?: GitStatusRow[];
            staged?: GitStatusRow[];
            conflicted?: string[];
          };
          const changed = (s.changed ?? []).flatMap((row) => {
            const paths = mapStatusPaths(row, toVaultPath);
            return paths
              ? [
                  {
                    ...paths,
                    working_dir: row.workingDir ?? row.working_dir ?? "",
                    index: row.index ?? "",
                  },
                ]
              : [];
          });
          const staged = (s.staged ?? []).flatMap((row) => {
            const paths = mapStatusPaths(row, toVaultPath);
            return paths ? [{ ...paths, index: row.index ?? "" }] : [];
          });
          const conflicted = (s.conflicted ?? []).flatMap((path) => {
            const mapped = mapVaultPath(path, toVaultPath);
            return mapped ? [mapped] : [];
          });
          ok(res, {
            paths_relative_to_vault: true,
            changed,
            staged,
            conflicted,
          });
        } catch (e) {
          fail(res, "git_error", e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      method: "post",
      path: "/git/diff",
      handler: async (req, res) => {
        const gm = gitManagerOf(app, res);
        if (!gm) return;
        if (typeof gm.getDiffString !== "function")
          return fail(res, "plugin_unreachable", "obsidian-git exposes no getDiffString()", {
            plugin: "git",
          });
        const path = str(body(req), "path");
        if (!path) return fail(res, "invalid_input", "path is required");
        const pathMappers = await requireGitPathMappers(app, gm, res, platform);
        if (!pathMappers) return;
        const repoPath = safeRepoPath(path, pathMappers);
        if (!repoPath)
          return fail(res, "invalid_input", "path must identify a file inside the git repository");
        const staged = body(req).staged === true;
        try {
          const diff = await gm.getDiffString(repoPath, staged);
          ok(res, { diff: typeof diff === "string" ? diff : "" });
        } catch (e) {
          fail(res, "git_error", e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      method: "post",
      path: "/git/log",
      handler: async (req, res) => {
        const gm = gitManagerOf(app, res);
        if (!gm) return;
        if (typeof gm.log !== "function")
          return fail(res, "plugin_unreachable", "obsidian-git exposes no log()", {
            plugin: "git",
          });
        const rawLimit = Number(body(req).limit);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
        try {
          const entries = (await gm.log(undefined, false, limit)) as Array<{
            hash?: string;
            message?: string;
            date?: string;
            author?: { name?: string } | string;
          }>;
          ok(res, {
            entries: (entries ?? []).map((e) => ({
              hash: e.hash ?? "",
              message: e.message ?? "",
              date: e.date ?? "",
              author: typeof e.author === "string" ? e.author : (e.author?.name ?? ""),
            })),
          });
        } catch (e) {
          fail(res, "git_error", e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      method: "post",
      path: "/git/stage",
      handler: async (req, res) => {
        const gm = gitManagerOf(app, res);
        if (!gm) return;
        if (typeof gm.stage !== "function")
          return fail(res, "plugin_unreachable", "obsidian-git exposes no stage()", {
            plugin: "git",
          });
        const paths = body(req).paths;
        if (
          !Array.isArray(paths) ||
          paths.length === 0 ||
          !paths.every((p) => typeof p === "string")
        )
          return fail(res, "invalid_input", "paths must be a non-empty string array");
        const pathMappers = await requireGitPathMappers(app, gm, res, platform);
        if (!pathMappers) return;
        const repoPaths = paths.map((path) => safeRepoPath(path, pathMappers));
        if (repoPaths.some((path) => path === null))
          return fail(
            res,
            "invalid_input",
            "every path must identify a file inside the git repository",
          );
        let staged = 0;
        try {
          for (const path of repoPaths) {
            await gm.stage(path as string, false);
            staged++;
          }
          ok(res, { staged });
        } catch (e) {
          // Report how many paths were staged before the failure — a bare error hides the
          // partial state (some staged, some not), leaving the caller unable to resume safely.
          fail(res, "git_error", e instanceof Error ? e.message : String(e), {
            staged,
            total: repoPaths.length,
          });
        }
      },
    },
    {
      method: "post",
      path: "/git/commit",
      handler: async (req, res) => {
        const gm = gitManagerOf(app, res);
        if (!gm) return;
        if (typeof gm.commit !== "function")
          return fail(res, "plugin_unreachable", "obsidian-git exposes no commit()", {
            plugin: "git",
          });
        const message = str(body(req), "message");
        if (!message) return fail(res, "invalid_input", "message is required");
        try {
          const committed = await gm.commit({ message });
          ok(res, {
            committed: typeof committed === "number" ? committed : null,
            fired_at: new Date().toISOString(),
          });
        } catch (e) {
          fail(res, "git_error", e instanceof Error ? e.message : String(e));
        }
      },
    },
  ];
}
