// GH #1027: the concise shape of a note write acknowledgement, shared by write_note, append_note,
// patch_note and update_frontmatter. A successful write needs to tell the caller where it landed and
// the new hash to CAS against (`prev_hash` on the next write); everything else in the detailed ack is
// either something the caller just sent (operation, anchor, created) or derivable from it.
//
// A SAFETY SIGNAL is never dropped. `quality_warning` and `poison_assessment` use null to mean "not
// computed", which carries nothing, so concise omits null; it also omits the clean cases ({flags: []},
// risk "none"), and keeps every non-empty one. `redactions` (memoryDefense redact mode: the persisted
// bytes differ from what the caller sent) and a non-zero blast radius (patch_note's lines/bytes
// removed) are kept for the same reason.
import type { PoisonAssessment } from "../../../experiential/poison";
import type { ResponseFormat } from "../../response-format";

interface WriteAckFields {
  vault: string;
  path: string;
  content_hash: string;
  quality_warning?: { flags: string[]; computed_at: number } | null;
  poison_assessment?: PoisonAssessment | null;
  redactions?: number;
  lines_removed?: number;
  bytes_removed?: number;
}

/** The ack for `format`: `full` unchanged for "detailed", the trimmed shape for "concise". */
export function shapeWriteAck<T extends WriteAckFields>(full: T, format: ResponseFormat) {
  if (format === "detailed") return full;
  const { vault, path, content_hash, quality_warning, poison_assessment } = full;
  return {
    vault,
    path,
    content_hash,
    ...(quality_warning && quality_warning.flags.length > 0 ? { quality_warning } : {}),
    ...(poison_assessment &&
    (poison_assessment.risk !== "none" || poison_assessment.signals.length > 0)
      ? { poison_assessment }
      : {}),
    ...(full.redactions ? { redactions: full.redactions } : {}),
    ...(full.lines_removed ? { lines_removed: full.lines_removed } : {}),
    ...(full.bytes_removed ? { bytes_removed: full.bytes_removed } : {}),
  };
}
