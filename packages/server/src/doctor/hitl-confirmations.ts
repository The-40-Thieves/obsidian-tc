// hitl.confirmations — per-tool confirmation outcomes over a recent window, content-free.
//
// Reads the code-only rows hitl-telemetry.ts writes (accept / decline / cancel, and timeout derived
// from unanswered offers). It is a REPORT: nothing here feeds back into a gate. Confirmation level
// is a security floor, never a learned preference — a high decline rate does not relax a prompt and
// a high accept rate does not skip one.
//
// WARNING, never FAIL: a tool approved mostly through headless tokens breaks nothing; it is the
// smell of an operator (or a script) clearing gates without seeing the on-screen prompt.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../db/open";
import { type HitlToolStats, readHitlConfirmationStats, total } from "../hitl-telemetry";
import type { Check, CheckResult } from "./types";

/** Token accepts needed on one tool before the headless smell is considered at all... */
export const HEADLESS_MIN_TOKEN_APPROVALS = 5;
/** ...and the share of that tool's accepts they must make up. */
export const HEADLESS_TOKEN_SHARE = 0.5;
const MAX_TOOL_LINES = 20;
/** The recent window doctor reads (still bounded by `eventLogDays` retention). */
export const HITL_DOCTOR_WINDOW_DAYS = 7;

export interface HitlConfirmationsProbe {
  tools: HitlToolStats[];
  /** Set when event_log could not be read: reported as a warning, never as "no outcomes". */
  error?: string;
}

export interface HitlConfirmationsView {
  /** The recent window the probe read, in days (also bounded by `eventLogDays` retention). */
  windowDays: number;
  /** Probe-only: reading event_log means opening cache.db, like every store-touching view. */
  probe?: () => HitlConfirmationsProbe;
}

const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`);

export function isHeadlessSmell(s: HitlToolStats): boolean {
  return (
    s.tokenAccept >= HEADLESS_MIN_TOKEN_APPROVALS &&
    s.tokenAccept / s.accept >= HEADLESS_TOKEN_SHARE
  );
}

export function hitlConfirmationsCheck(view: HitlConfirmationsView): Check {
  return {
    id: "hitl.confirmations",
    category: "security",
    run: (): CheckResult => {
      if (!view.probe) {
        return {
          status: "ok",
          summary:
            "confirmation outcomes (not probed): run `doctor --probe` to read the recent HITL answers",
          details: { confirmations: "not probed" },
        };
      }
      const probed = view.probe();
      if (probed.error !== undefined) {
        return {
          status: "warning",
          summary: `confirmation outcomes could not be read: ${probed.error}`,
          details: { confirmations: "unreadable" },
        };
      }
      const tools = probed.tools.filter((s) => total(s) > 0);
      const window = `${view.windowDays}d`;
      if (tools.length === 0) {
        return {
          status: "ok",
          summary: `no confirmation outcomes recorded in the last ${window}`,
          details: { window, confirmations: "0" },
        };
      }
      const all = tools.reduce((n, s) => n + total(s), 0);
      const accepted = tools.reduce((n, s) => n + s.accept, 0);
      const details: Record<string, string | string[]> = {
        window,
        confirmations: String(all),
        acceptRate: pct(accepted, all),
      };
      for (const s of tools.slice(0, MAX_TOOL_LINES)) {
        details[`tool.${s.tool}`] =
          `accept=${s.accept} decline=${s.decline} cancel=${s.cancel} timeout=${s.timeout} ` +
          `acceptRate=${pct(s.accept, total(s))} tokenApprovals=${s.tokenAccept}`;
      }
      if (tools.length > MAX_TOOL_LINES) {
        details.omittedTools = String(tools.length - MAX_TOOL_LINES);
      }
      const flagged = tools.filter(isHeadlessSmell);
      const summary = `${all} confirmation outcome(s) across ${tools.length} tool(s) in the last ${window}, acceptance ${pct(accepted, all)}`;
      if (flagged.length === 0) return { status: "ok", summary, details };
      const clientLines = flagged.map((s) => {
        const clients = Object.entries(s.tokenClients)
          .sort((a, b) => b[1] - a[1])
          .map(([c, n]) => `${c} x${n}`)
          .join(", ");
        return `${s.tool}: ${s.tokenAccept} of ${s.accept} approvals redeemed a headless token (${clients})`;
      });
      return {
        status: "warning",
        summary: `${summary}; ${flagged.length} tool(s) mostly approved by headless token`,
        details,
        issues: clientLines,
        remediation:
          "Tokens come from `obsidian-tc elicit`, which clears a gate without the on-screen prompt. " +
          "Check who runs it for these tools; if the client cannot show the prompt, prefer one that can. " +
          "This report never changes a confirmation requirement.",
      };
    },
  };
}

/** The `doctor --probe` reader: per-tool outcomes over the last `windowDays`. Never throws; a
 *  missing cache.db reports none, an unreadable one reports `error`. */
export async function probeHitlConfirmations(
  cacheDir: string,
  busyTimeoutMs: number,
  opts: { windowDays: number; ttlSeconds: number; now?: number },
): Promise<HitlConfirmationsProbe> {
  const path = join(cacheDir, "cache.db");
  if (!existsSync(path)) return { tools: [] };
  let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
  try {
    db = await openDatabase(path, busyTimeoutMs, { readonly: true });
    const nowMs = opts.now ?? Date.now();
    return {
      tools: readHitlConfirmationStats(db, {
        sinceMs: nowMs - opts.windowDays * 86_400_000,
        nowMs,
        ttlMs: opts.ttlSeconds * 1000,
      }),
    };
  } catch (e) {
    return { tools: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    try {
      db?.close?.();
    } catch {
      // best-effort close: the outcome is already decided, a failing close changes nothing
    }
  }
}
