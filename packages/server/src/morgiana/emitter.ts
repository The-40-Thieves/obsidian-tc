// MORGIANA spool emitter (G2.4 §MORGIANA events — THE-183). Writes CloudEvents 1.0 JSONL to a
// per-vault, per-day spool file under <cacheDir>/<vault>/morgiana-events-<YYYY-MM-DD>.jsonl
// (daily rotation by date, matching the G2.3 D8 trace layout). MORGIANA tails the file. The
// emitter is FAIL-SOFT by contract: emit() never throws and never blocks the caller — a write
// failure drops the event and reports it via onDropped (which feeds morgiana_emit_dropped_total
// and the event_log). The clock and uuid are injectable so tests are fully deterministic.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type CloudEvent,
  CloudEventSchema,
  type MorgianaEventData,
  type MorgianaEventType,
} from "@the-40-thieves/obsidian-tc-shared";

export interface MorgianaEmitterOptions {
  /** Spool root; events go to <cacheDir>/<vault>/morgiana-events-<date>.jsonl. */
  cacheDir: string;
  /** Whether the local JSONL spool is enabled (G2.4 default true). */
  spool: boolean;
  /** Injected clock (default new Date) for deterministic tests. */
  now?: () => Date;
  /** Injected uuid (default crypto.randomUUID) for deterministic tests. */
  uuid?: () => string;
  /** Fail-soft sink: called when an event is dropped (vaultId, reason). */
  onDropped?: (vaultId: string, reason: string) => void;
}

/**
 * Reduce a vault id to a single safe path segment so the spool can never escape cacheDir.
 * Besides collapsing path separators and other unsafe characters, a sanitized segment of
 * only dots (".", "..", ...) - or the empty string - is mapped to "_" so it can never
 * resolve as a relative path component (e.g. join(cacheDir, "..") escaping a level up).
 * Exported for unit testing.
 */
export function safeVault(vaultId: string): string {
  const s = vaultId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return [...s].some((c) => c !== ".") ? s : "_";
}

export class MorgianaEmitter {
  private readonly cacheDir: string;
  private readonly spoolEnabled: boolean;
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private readonly onDropped?: (vaultId: string, reason: string) => void;

  constructor(opts: MorgianaEmitterOptions) {
    this.cacheDir = opts.cacheDir;
    this.spoolEnabled = opts.spool;
    this.now = opts.now ?? (() => new Date());
    this.uuid = opts.uuid ?? randomUUID;
    this.onDropped = opts.onDropped;
  }

  get enabled(): boolean {
    return this.spoolEnabled;
  }

  /** Build a validated CloudEvents 1.0 envelope (source = obsidian-tc/<vault>). */
  envelope(
    vaultId: string,
    type: MorgianaEventType,
    data: Partial<MorgianaEventData> = {},
  ): CloudEvent {
    return CloudEventSchema.parse({
      specversion: "1.0",
      id: this.uuid(),
      source: `obsidian-tc/${vaultId}`,
      type,
      time: this.now().toISOString(),
      data: { ...data, vault_id: data.vault_id ?? vaultId },
    });
  }

  /** Emit one event. Fail-soft: never throws, never blocks; a drop calls onDropped. */
  emit(vaultId: string, type: MorgianaEventType, data: Partial<MorgianaEventData> = {}): void {
    if (!this.spoolEnabled) return;
    try {
      this.write(vaultId, this.envelope(vaultId, type, data));
    } catch {
      try {
        this.onDropped?.(vaultId, "spool_write_failed");
      } catch {
        /* the drop sink must never throw either */
      }
    }
  }

  private write(vaultId: string, event: CloudEvent): void {
    const dir = join(this.cacheDir, safeVault(vaultId));
    mkdirSync(dir, { recursive: true });
    const date = event.time.slice(0, 10); // YYYY-MM-DD from the rfc3339 time
    appendFileSync(
      join(dir, `morgiana-events-${date}.jsonl`),
      `${JSON.stringify(event)}\n`,
      "utf8",
    );
  }
}
