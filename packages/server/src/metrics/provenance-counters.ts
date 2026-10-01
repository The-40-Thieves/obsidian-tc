// The write-provenance fault counter. Its own module because registry.ts sits at biome's per-file
// line cap; MetricsRecorder owns one instance and delegates, so callers still see a single recorder.
import { Counter, type Registry } from "prom-client";

export class ProvenanceCounters {
  private readonly faults: Counter<string>;

  constructor(registers: Registry[]) {
    this.faults = new Counter({
      name: "obsidian_tc_provenance_faults_total",
      help: "Write-provenance recording faults, by vault, tool and kind. `omitted`: a committed write left NO record (recording is fail-open, so the write still succeeded). `head_untrusted`: the record was written but the chain head failed validation and was not re-signed. Any non-zero value means the provenance trail is incomplete or was tampered with; doctor reports the same events from event_log. Labels are vault id, tool name and the two-value kind, never a path or an error message.",
      labelNames: ["vault", "tool", "kind"],
      registers,
    });
  }

  incFault(vault: string, tool: string, kind: "omitted" | "head_untrusted"): void {
    this.faults.inc({ vault, tool, kind });
  }
}
