// experiential.capture-location (THE-891 item 3) — does cacheDir, where captured episode content
// (agent_episodes.args_json) and session traces actually live, resolve INSIDE any configured
// vault root?
//
// Its own module rather than more of checks.ts, same reasoning as note-summary-scale.ts and
// column-liveness.ts: that file is already comment-dense against biome's 700-line ceiling, and
// this is a self-contained classifier. Re-exported from doctor/index.ts so every existing
// importer of the doctor surface stays unaffected.
//
// THE REAL EXPOSURE bounded retention (THE-891 item 1) and the first-run notice (item 2) do not
// touch is LOCATION. A vault commonly lives inside iCloud Drive, Dropbox, or a Syncthing-watched
// folder — that IS the point of a vault sync setup — so a cacheDir placed under (or equal to) a
// vault root gets silently replicated off the machine by whatever already watches that vault,
// regardless of what captureContent or captureRetentionDays are set to. Neither of the other two
// mitigations can see this: retention bounds how OLD a captured row is, the notice states WHERE
// cacheDir is, but nothing before this told an operator whether that stated location itself
// happens to sit inside a sync target.
//
// THE SHIPPED DEFAULT IS ALREADY SAFE. config/load.ts's finalizeConfig anchors a relative
// cacheDir (the schema default, ".obsidian-tc") to homedir() — resolving to `~/.obsidian-tc` —
// which sits outside every vault root by construction, since a vault path is never the user's
// home directory itself. Nothing about a stock install needs this check. What it guards is the
// MISCONFIGURED case: an operator who set an explicit `cacheDir` (or whose `vaults[].path`
// happens to already contain wherever cacheDir resolves) — the schema's `cacheDir: z.string()`
// accepts any path and validates independently of `vaults`, so this can only be caught once both
// are resolved together, which is exactly what doctor is for.
import { isAbsolute, relative, resolve } from "node:path";
import type { Check, CheckStatus } from "./types";

export interface CaptureLocationView {
  cacheDir: string;
  vaults: readonly { id: string; path: string }[];
}

/** True when `dir` is `root` itself, or nested inside it. Same containment idiom as
 *  workspace/sessions.ts's resolveCacheTracePath: resolve both sides, then require the relative
 *  path never climbs out with `..` and never comes back absolute (which `path.relative` returns
 *  on Windows for paths on different drives). */
function isInside(root: string, dir: string): boolean {
  const r = resolve(root);
  const d = resolve(dir);
  if (r === d) return true;
  const rel = relative(r, d);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * experiential.capture-location — warns when cacheDir sits inside a vault a sync client might be
 * watching. Never fails: a misplaced cacheDir does not break retrieval or writes, so this matches
 * the same "diagnostic, not a hard error" posture as search.note-summaries-scale.
 *
 * No `--probe` gate: unlike a store-touching check, this reads only two already-resolved config
 * values and does one path comparison per vault — cheap enough, and offline enough, to run on
 * every default doctor pass.
 */
export function captureLocationCheck(view: CaptureLocationView): Check {
  return {
    id: "experiential.capture-location",
    category: "security",
    run: () => {
      const offenders = view.vaults.filter((v) => isInside(v.path, view.cacheDir));
      const details: Record<string, string | string[]> = {
        cacheDir: view.cacheDir,
        vaults: view.vaults.map((v) => `${v.id}=${v.path}`),
      };
      if (offenders.length === 0) {
        return {
          status: "ok" as CheckStatus,
          summary: "cacheDir sits outside every configured vault root",
          details,
        };
      }
      return {
        status: "warning" as CheckStatus,
        summary: `cacheDir is INSIDE ${offenders.length} vault root(s) — captured content may silently sync off this machine`,
        details,
        issues: offenders.map(
          (v) =>
            `vault ${v.id} (${v.path}) contains cacheDir (${view.cacheDir}) — any sync client watching this vault (iCloud Drive, Dropbox, Syncthing, git) will replicate captured tool-call content and session traces along with everything else in it`,
        ),
        remediation:
          'Move cacheDir outside every vault root. The schema default (".obsidian-tc", anchored to the home directory by config/load.ts\'s finalizeConfig) already does this — only an explicit cacheDir override, or a vault path chosen after cacheDir, can trigger this warning. See experiential.captureContent / experiential.captureRetentionDays for what is captured and for how long.',
      };
    },
  };
}
