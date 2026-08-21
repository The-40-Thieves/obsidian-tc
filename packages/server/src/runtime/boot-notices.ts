// server-runtime.ts's `start()` was pushed over biome's 700-line ceiling by THE-891 item 2's new
// capture notice — the three stderr-only, side-effect-free boot notices (security posture
// summary, THE-825 plane opt-in, THE-891 capture first-run) are pulled into this one call so the
// composition root stays under it. Same "extracted for the line budget, behavior unchanged"
// reasoning maintenance-wiring.ts's own header documents for THE-466 slice 3: nothing about WHEN
// or WHAT these print changes, only where the code that decides it lives. All three were already
// independent blocks with no shared state beyond `config`, so folding them into one function is a
// pure move, not a refactor of behavior.
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { emitCaptureFirstRunNotice } from "./capture-first-run-notice";
import { formatPlaneOptInNotice } from "./plane-opt-in-notice";

export function emitBootNotices(deps: {
  config: ServerConfig;
  /** `roles !== null` at the buildServerRuntime call site — see plane-opt-in-notice.ts. */
  gatewayConfigured: boolean;
  /** Whether the raw (pre-default) config explicitly set `plane.enabled` — see
   *  config/load.ts's `isPlaneEnabledExplicit`. */
  planeEnabledExplicit: boolean;
}): void {
  const { config } = deps;

  // Security posture summary (audit #268 P1): make the active profile obvious at startup, and
  // warn when the permissive trusted-local defaults are active — governed by default is not
  // least-privilege by default. stderr only (the stdio MCP protocol owns stdout).
  const rootAcl = config.acl;
  // THE-526: name the active profile so it is a stated fact, not something inferred from six
  // fields.
  const profile = config.securityProfile ?? "trusted-local";
  process.stderr.write(
    `security: profile=${profile} auth=${config.auth.mode} readOnly=${rootAcl.readOnly} strictRead=${rootAcl.strictReadDefault} requireCas=${config.writes.requireCas} http=${config.transports.http.enabled ? "on" : "off"}\n`,
  );
  if (
    config.auth.mode === "none" &&
    !rootAcl.readOnly &&
    !rootAcl.strictReadDefault &&
    !config.writes.requireCas
  ) {
    process.stderr.write(
      "security: running with trusted-local defaults (auth=none, no strict-read, no CAS). For a " +
        'shared or multi-caller deployment set securityProfile: "hardened" (strictReadDefault, ' +
        "requireCas, snapshots, HTTP off) plus your read/write paths, or copy " +
        "examples/config.hardened.json.\n",
    );
  }

  // THE-825: plane opt-in boot notice — silent by default is the failure mode this closes. See
  // plane-opt-in-notice.ts.
  const planeNotice = formatPlaneOptInNotice({
    gatewayConfigured: deps.gatewayConfigured,
    planeEnabledExplicit: deps.planeEnabledExplicit,
  });
  if (planeNotice) process.stderr.write(planeNotice);

  // THE-891 item 2: one-time (per-install) capture notice — see capture-first-run-notice.ts.
  emitCaptureFirstRunNotice({
    captureContent: config.experiential.captureContent,
    cacheDir: config.cacheDir,
    retentionDays: config.experiential.captureRetentionDays,
  });
}
