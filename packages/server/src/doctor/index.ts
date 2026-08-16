// THE-521 — doctor: a runtime-health command with a machine-readable capability report.
//
// config-validate/config-show are static (they lint the file). doctor probes runtime TRUTH and emits
// a versioned JSON envelope with human text rendered from it. Motivated by the 5-day MCP outage where
// every layer reported success in its own terms (empty tools/list, a valid 401, an exp reading 2027)
// — doctor exists to answer "is this install healthy right now?" in one artifact.
// THE-688 fix 2: the opt-in probe's result type, so the CLI can build a probe without importing
// through the checks module directly.
export type { DerivedColumnState, DerivedTableState, KbHealthProbe } from "./checks";
// entrypoints.liveness — the verb-side companion to derived.liveness. Same probe-injection
// contract, so the CLI builds its probe without importing through the checks module.
export type {
  EntryPointsProbe,
  EntryPointsView,
  ScheduledPassState,
  ToolCensus,
} from "./entrypoints";
export { entryPointsCheck } from "./entrypoints";
export { renderText, runDoctor } from "./report";
// THE-837: DenseProbeResult moved to ./retrieval-heads when retrievalHeadsCheck was extracted
// (checks.ts had crossed biome's 700-line ceiling). Re-exported from this barrel exactly as before,
// so every consumer outside doctor/ is unaffected by where the symbol now lives.
export type { DenseProbeResult } from "./retrieval-heads";
export type { AssembleOptions, DoctorConfigView } from "./run";
export { assembleDoctorReport, decodeTokenClaims } from "./run";
export type {
  Check,
  CheckResult,
  CheckStatus,
  DoctorCheck,
  DoctorContext,
  DoctorReport,
} from "./types";
