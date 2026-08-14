// THE-825 / GH #786 — `plane.enabled` flipped from defaulting `true` to defaulting `false`:
// ambient sleep-time LLM work (synthesis, audit, contradiction judging) over the WHOLE vault must
// be opt-in, not something a gateway configured for an unrelated feature (e.g. `reflect`) silently
// implies consent to.
//
// The failure mode of a silent flip is exactly the shape this project keeps filing tickets about:
// the plane simply stops, and "why is nothing being consolidated" becomes a support path. So a
// deployment that HAS a gateway configured — the only population this flip changes behaviour for,
// since `plane.enabled` is inert without one — and never stated `plane.enabled` in its config gets
// one loud, actionable line at boot. A deployment that wrote `plane.enabled: false` on purpose is
// NOT nagged: `planeEnabledExplicit` distinguishes "absent, defaulted" from "explicitly declined",
// which the resolved config alone cannot (see config/load.ts's `isPlaneEnabledExplicit`).
//
// Extracted as a pure function — mirrors reconcile-outcome.ts's `applyReconcileOutcome` — so the
// gating logic is assertable without booting a real runtime or connecting stdio.
export function formatPlaneOptInNotice(deps: {
  /** `roles !== null` at the buildServerRuntime call site: true only when an inference gateway
   *  actually resolved (OBSIDIAN_TC_GATEWAY_URL env var, or config.gateway.baseUrl). Without a
   *  gateway, `plane.enabled` does nothing either way, so nagging would be pure noise. */
  gatewayConfigured: boolean;
  /** Whether the raw (pre-default) config explicitly set `plane.enabled` — computed from the raw
   *  file object, never from the resolved ServerConfig (which cannot tell "absent" from "false"). */
  planeEnabledExplicit: boolean;
}): string | null {
  if (!deps.gatewayConfigured || deps.planeEnabledExplicit) return null;
  return (
    "[plane] ambient consolidation (synthesis/audit/contradiction judging) is opt-in as of this " +
    "release and is currently OFF: an inference gateway is configured but plane.enabled was not " +
    'set. Add "plane": { "enabled": true } to obsidian-tc.config.json to restore it.\n'
  );
}
