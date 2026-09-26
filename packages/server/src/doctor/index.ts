// THE-521 — doctor: a runtime-health command with a machine-readable capability report.
//
// config-validate/config-show are static (they lint the file). doctor probes runtime TRUTH and emits
// a versioned JSON envelope with human text rendered from it. Motivated by the 5-day MCP outage where
// every layer reported success in its own terms (empty tools/list, a valid 401, an exp reading 2027)
// — doctor exists to answer "is this install healthy right now?" in one artifact.
// THE-688 fix 2: the opt-in probe's result type, so the CLI can build a probe without importing
// through the checks module directly.

// THE-891 item 3: experiential.capture-location's view type, so the CLI can build it without
// importing through checks.ts — same barrel reasoning as every other doctor/*.ts submodule below.
export type { CaptureLocationView } from "./capture-location";
export { captureLocationCheck } from "./capture-location";
export type { DerivedColumnState, DerivedTableState, KbHealthProbe } from "./checks";
// THE-1078: experiential.citation-judge's PROBE RESULT type only — cli/commands/doctor.ts's
// `probeTypesafeCitationJudge` returns this and imports it through this barrel (`from
// "../../doctor"`). `CitationJudgeView`/`citationJudgeCheck` are deliberately NOT re-exported
// here: nothing imports them through this barrel — run.ts imports both directly from
// "./citation-judge" (as does the check's own test), so re-exporting them here would be a dead
// path with no caller.
export type { CitationJudgeProbeResult } from "./citation-judge";
// THE-939: install.conflict-copies' view type and its own install-root resolver, so the CLI can
// build both without importing through checks.ts — same barrel reasoning as every other
// doctor/*.ts submodule in this file.
export type { ConflictCopiesView } from "./conflict-copies";
export { conflictCopiesCheck, resolveInstallRoot } from "./conflict-copies";
// THE-1039 (GH #930): db.reclaimable-space's view type, same barrel reasoning as capture-location
// above — the CLI builds it without importing through checks.ts.
export type { DbSpaceState, DbSpaceView, FtsDataRowCount } from "./db-space";
export { dbSpaceCheck } from "./db-space";
// entrypoints.liveness — the verb-side companion to derived.liveness. Same probe-injection
// contract, so the CLI builds its probe without importing through the checks module.
export type {
  EntryPointsProbe,
  EntryPointsView,
  ScheduledPassState,
  ToolCensus,
} from "./entrypoints";
export { entryPointsCheck } from "./entrypoints";
// THE-1073: index.coverage's probe result type, so the CLI can build it without importing through
// checks.ts — same barrel reasoning as every other doctor/*.ts submodule in this file.
export type { IndexCoverageState } from "./index-coverage";
// THE-891 item 5: search.note-summaries-scale's probe result type, same reasoning as the
// derived-table/column probes above — the CLI builds its probe without importing through checks.ts.
export type { NoteSummaryScaleState } from "./note-summary-scale";
export { renderText, runDoctor } from "./report";
// THE-837: DenseProbeResult moved to ./retrieval-heads when retrievalHeadsCheck was extracted
// (checks.ts had crossed biome's 700-line ceiling). Re-exported from this barrel exactly as before,
// so every consumer outside doctor/ is unaffected by where the symbol now lives.
export type { DenseProbeResult } from "./retrieval-heads";
export type { AssembleOptions, DoctorConfigView } from "./run";
export { assembleDoctorReport, decodeTokenClaims } from "./run";
// THE-1108: sessions.liveness's probe result type, same barrel reasoning as every other
// doctor/*.ts submodule above — the CLI builds its probe without importing through checks.ts.
export type { SessionLivenessProbe, SessionLivenessView } from "./session-liveness";
export { sessionLivenessCheck } from "./session-liveness";
// THE-1125: telemetry's view type, same barrel reasoning as every other doctor/*.ts submodule
// above — the CLI builds it without importing through checks.ts.
export type { TelemetryView } from "./telemetry";
export { telemetryCheck } from "./telemetry";
// THE-1123: toolFacade's view type, same barrel reasoning as every other doctor/*.ts submodule
// above — the CLI builds it without importing through checks.ts.
export type { ToolFacadeView } from "./tool-facade";
export { toolFacadeCheck } from "./tool-facade";
export type {
  Check,
  CheckResult,
  CheckStatus,
  DoctorCheck,
  DoctorContext,
  DoctorReport,
} from "./types";
