// Obsidian Git (THE-378, WP6.1 extraction from routes.ts). The git plugin exposes no stable
// `api`, so every method is probed before use and absence degrades, never throws. Every git
// operation is wrapped so a git failure comes back as git_error, never a 500.
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
  getDiffString?: (path: string, staged?: boolean) => Promise<unknown>;
  log?: (file: undefined, relativeToVault: boolean, limit: number) => Promise<unknown>;
  stage?: (path: string, relativeToVault: boolean) => Promise<unknown>;
  commit?: (opts: { message: string }) => Promise<unknown>;
}

/** Resolve obsidian-git's gitManager, mapping absence onto the error taxonomy. */
function gitManagerOf(app: InternalApp, res: BridgeRes): GitManagerLite | null {
  const plugin = communityPlugin(app, "git") as
    | (CommunityPlugin & { gitManager?: GitManagerLite })
    | undefined;
  if (!plugin) {
    fail(res, "plugin_missing", "obsidian-git is not installed", { plugin: "git" });
    return null;
  }
  if (!plugin.gitManager) {
    fail(res, "plugin_unreachable", "obsidian-git exposes no gitManager", { plugin: "git" });
    return null;
  }
  return plugin.gitManager;
}

export function buildGitRoutes(app: InternalApp): RouteDef[] {
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
        try {
          const s = (await gm.status()) as {
            changed?: Array<{ path?: string; working_dir?: string; index?: string }>;
            staged?: Array<{ path?: string; index?: string }>;
            conflicted?: string[];
          };
          ok(res, {
            changed: (s.changed ?? []).map((f) => ({
              path: f.path ?? "",
              working_dir: f.working_dir ?? "",
              index: f.index ?? "",
            })),
            staged: (s.staged ?? []).map((f) => ({ path: f.path ?? "", index: f.index ?? "" })),
            conflicted: s.conflicted ?? [],
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
        const staged = body(req).staged === true;
        try {
          const diff = await gm.getDiffString(path, staged);
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
        let staged = 0;
        try {
          for (const p of paths as string[]) {
            await gm.stage(p, true);
            staged++;
          }
          ok(res, { staged });
        } catch (e) {
          // Report how many paths were staged before the failure — a bare error hides the
          // partial state (some staged, some not), leaving the caller unable to resume safely.
          fail(res, "git_error", e instanceof Error ? e.message : String(e), {
            staged,
            total: paths.length,
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
