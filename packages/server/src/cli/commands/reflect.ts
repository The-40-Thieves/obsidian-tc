import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { version as VERSION } from "../../../package.json";
import { provisionExperientialDb } from "../../db/experiential";
import { openDatabase } from "../../db/open";
import type { Database } from "../../db/types";
import {
  type DeriveClosedWindowsOutcome,
  deriveClosedWindows,
} from "../../experiential/derive-verdict";
import { evaluateEpisodes, extractPreferences } from "../../experiential/reflect";
import { errorMessage } from "../../util/errors";
import { type Cmd, experientialMigrations, resolveOrUsageExit } from "../shared";

export async function run_reflect(cmd: Cmd<"reflect">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.input);
  mkdirSync(cfg.cacheDir, { recursive: true });
  const edb = await provisionExperientialDb(cfg.cacheDir, experientialMigrations, {
    version: VERSION,
  });
  // THE-726 fix round 3: cache.db is now opened INSIDE the guarded derive step below, not
  // unconditionally here. Opening it here (round 1) meant an unreadable or corrupt cache.db (bad
  // permissions, a stale lock, disk error) aborted the WHOLE command before evaluateEpisodes ever
  // ran - a regression from before this pass existed, when `citationPreferences` off meant
  // eligibility never touched cache.db at all. `cacheDb` stays `undefined` on any open failure;
  // every downstream use already tolerates that (extractPreferences already accepts
  // `cacheDb: undefined` when `citationPreferences` is off).
  let cacheDb: Database | undefined;
  try {
    const nowMs = Date.now();
    // THE-726: derive verdicts for every ended session with open judgeable rows BEFORE the
    // eligibility pass runs, so a freshly-derived -1 is held in the same pass when
    // derivedVerdictHold is on (evaluateEpisodes below re-reads task_result/verdict_source fresh).
    //
    // THE-726 review round 1: wrapped in its own try/catch — this is an ADDITION in front of the
    // working eligibility pass below, and a throw here (a cache.db this process never provisioned,
    // a lock, anything else) must not take that pass down with it. `deriveClosedWindows` itself now
    // guards the specific "cache.db exists but was never provisioned" case (no `workspace_sessions`
    // table) and no-ops; this catch is the net for everything else, INCLUDING the open itself now
    // (round 3) - `openDatabase` throwing lands here exactly the same way as `deriveClosedWindows`
    // throwing always did.
    let derived: DeriveClosedWindowsOutcome | undefined;
    try {
      cacheDb = await openDatabase(join(cfg.cacheDir, "cache.db"));
      derived = await deriveClosedWindows(edb, cacheDb, { nowMs });
    } catch (e) {
      process.stderr.write(`reflect: derived-verdict pass failed: ${errorMessage(e)}\n`);
      // THE-726 fix round 3 follow-up (R2): `cacheDb` staying undefined at this point means the
      // OPEN itself failed (a successful open assigns it even if deriveClosedWindows then throws
      // for an unrelated reason). When citationPreferences is on, that open failure silently
      // starved extractPreferences of its citation evidence source below - the command still
      // printed a normal-looking applied=N line for every vault, with no indication that citation
      // evidence was never consulted this run. Naming the gap explicitly, with the same error, so
      // an operator does not read a quiet applied=0 (or a lower applied=N) as "no evidence existed"
      // when it actually means "cache.db could not be read".
      if (cacheDb === undefined && cfg.experiential.citationPreferences) {
        process.stderr.write(
          `reflect: citation-preference evidence unavailable this run - cache.db could not be opened: ${errorMessage(e)}\n`,
        );
      }
    }
    // THE-701 removed the eligibility pass's judge; THE-673 removed extractPreferences' judge too
    // (a deterministic counter over typed evidence, see that file) — this command no longer needs
    // a GatewayClient at all.
    const stats = await evaluateEpisodes(edb, {
      nowMs,
      derivedVerdictHold: cfg.experiential.derivedVerdictHold,
    });
    // THE-710: the preference plane is partitioned by vault, so extraction fans out per configured
    // vault the way the note-quality job does. Reported PER VAULT rather than summed: a single
    // "applied=N" across vaults would hide that one vault produced everything and another nothing,
    // which is exactly the blend the partition exists to make visible.
    const lines: string[] = [];
    for (const v of cfg.vaults) {
      const prefs = await extractPreferences(edb, v.id, {
        nowMs,
        // THE-644: `experiential.citationPreferences` is the ship-dark gate on the citation
        // evidence source in extractPreferences - off by default. Handing it `cacheDb` only when
        // the flag is on keeps that gate byte-identical. THE-726 fix round 3 follow-up (R1/R2):
        // cache.db is opened INSIDE the guarded derive step above now, not unconditionally before
        // it, so it is NOT always open here - `cacheDb` is undefined whenever that open failed,
        // and this expression already falls through to `undefined` in that case (never handing
        // extractPreferences a stale or partially-opened handle), the same as when the flag is off.
        cacheDb: cfg.experiential.citationPreferences ? cacheDb : undefined,
      });
      lines.push(
        `preferences[${v.id}]: ${
          prefs.skipped
            ? "skipped (no evidence)"
            : `applied=${prefs.applied} version=${prefs.version}`
        }`,
      );
    }
    const derivedLine = derived
      ? `reflect: derived_sessions=${derived.sessionsSeen} derived_stamped=-1:${derived.stamped.minus} 0:${derived.stamped.zero} +1:${derived.stamped.plus} drained:${derived.stamped.drained} derived_skipped=${derived.skipped}\n`
      : "reflect: derived-verdict pass failed (see stderr) — eligibility pass ran anyway\n";
    process.stdout.write(
      derivedLine +
        `reflect: scanned=${stats.scanned} promoted=${stats.promoted} held=${stats.held} denied=${stats.denied}\n` +
        `${lines.join("\n")}\n`,
    );
  } finally {
    edb.close?.();
    cacheDb?.close?.();
  }
  return;
}
