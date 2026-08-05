// THE-733 / THE-631 item 1 — the per-vault score calibration.
//
// The assertions that matter are the REFUSALS. THE-631 condemned the naive implementation of its
// own item 1 in advance — "a confidence number computed from another vault's percentiles is worse
// than no confidence number, because it looks authoritative" — and the only number otherwise
// reachable from the request path is DEFAULT_GAP_THRESHOLD, an n=136 calibration on ONE vault.
// So every path that cannot support a percentile must say so, with a reason, rather than produce
// one.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import type { Database } from "../src/db/types";
import {
  confidenceFor,
  MIN_CALIBRATION_N,
  persistCalibration,
  readLatestCalibration,
  type ScoreCalibration,
} from "../src/experiential/calibration";
import { openMemoryDb } from "./helpers";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
const EXP_CHAIN = EXPERIENTIAL_MIGRATION_FILES.map((file) => ({
  version: versionOf(file),
  sql: read(file),
}));

const T = 1_700_000_000_000;

/** A realistic distribution — the shape gaps.ts records for this vault. */
const cal = (over: Partial<ScoreCalibration> = {}): ScoreCalibration => ({
  vault_id: "main",
  computed_at: T,
  n: 250,
  min: 0.1154,
  p5: 0.1389,
  p10: 0.1497,
  p25: 0.16,
  median: 0.1833,
  p75: 0.21,
  p90: 0.24,
  p95: 0.26,
  engine_version: "1.19.0",
  config_fingerprint: null,
  ...over,
});

describe("THE-733: an uncalibrated vault gets NO confidence, never a borrowed one", () => {
  it("reports not_calibrated rather than falling back to a global constant", () => {
    const c = confidenceFor(0.19, null, "1.19.0");
    expect(c.available).toBe(false);
    if (!c.available) expect(c.reason).toBe("not_calibrated");
  });

  it("distinguishes NOT ENOUGH SAMPLES from NOT CALIBRATED — different facts", () => {
    // One means nobody ran it. The other means it ran and cannot support the claim. Collapsing
    // them would hide a calibration that needs re-running behind one that was never done.
    const c = confidenceFor(0.19, cal({ n: MIN_CALIBRATION_N - 1 }), "1.19.0");
    expect(c.available).toBe(false);
    if (!c.available) expect(c.reason).toBe("not_enough_samples");
  });

  it("reports no_results when the search returned nothing to place", () => {
    const c = confidenceFor(undefined, cal(), "1.19.0");
    expect(c.available).toBe(false);
    if (!c.available) expect(c.reason).toBe("no_results");
  });
});

describe("THE-733: placing a score in the distribution", () => {
  it("puts a median score near p50 and a p95 score at the top", () => {
    const mid = confidenceFor(0.1833, cal(), "1.19.0");
    expect(mid.available).toBe(true);
    if (mid.available) {
      expect(mid.percentile).toBeCloseTo(50, 0);
      expect(mid.band).toBe("moderate");
    }
    const hi = confidenceFor(0.26, cal(), "1.19.0");
    if (hi.available) {
      expect(hi.percentile).toBe(95);
      expect(hi.band).toBe("high");
    }
  });

  it("a score at or below the observed minimum is the LOW band, not an error", () => {
    const c = confidenceFor(0.05, cal(), "1.19.0");
    expect(c.available).toBe(true);
    if (c.available) {
      expect(c.percentile).toBe(0);
      expect(c.band).toBe("low");
    }
  });

  it("INTERPOLATES between anchors rather than snapping to one", () => {
    // Nine anchors snapped would report the same percentile across a wide score range and make the
    // signal look coarser than the data behind it. Halfway between p25 (0.16) and median (0.1833)
    // must land strictly between 25 and 50.
    const c = confidenceFor((0.16 + 0.1833) / 2, cal(), "1.19.0");
    expect(c.available).toBe(true);
    if (c.available) {
      expect(c.percentile).toBeGreaterThan(25);
      expect(c.percentile).toBeLessThan(50);
    }
  });

  it("survives a DEGENERATE distribution where two anchors share a score", () => {
    // A flat vault can produce p25 === median. Dividing by that zero width would yield Infinity or
    // NaN and poison the band, turning a data quirk into a nonsense confidence.
    const c = confidenceFor(0.16, cal({ p25: 0.16, median: 0.16, p75: 0.16 }), "1.19.0");
    expect(c.available).toBe(true);
    if (c.available) {
      expect(Number.isFinite(c.percentile)).toBe(true);
      expect(c.band).toMatch(/low|moderate|high/);
    }
  });

  it("FLAGS a calibration from another engine version without discarding it", () => {
    // Discarding would drop back to no-confidence, which is worse: a slightly stale percentile is
    // still grounded in THIS vault, where the alternative is grounded in nothing.
    const c = confidenceFor(0.1833, cal({ engine_version: "1.14.0" }), "1.19.0");
    expect(c.available).toBe(true);
    if (c.available) {
      expect(c.stale_calibration).toBe(true);
      expect(c.percentile).toBeCloseTo(50, 0);
    }
    const fresh = confidenceFor(0.1833, cal(), "1.19.0");
    if (fresh.available) expect(fresh.stale_calibration).toBe(false);
  });
});

describe("THE-733: persistence", () => {
  let db: Database;
  beforeEach(() => {
    db = openMemoryDb();
    runMigrations(db, EXP_CHAIN);
  });

  it("an uncalibrated vault reads back null — the baseline the refusal rests on", () => {
    expect(readLatestCalibration(db, "main")).toBeNull();
  });

  it("round-trips, and is APPEND-ONLY with the latest winning", () => {
    persistCalibration(db, cal({ computed_at: T, median: 0.1 }));
    persistCalibration(db, cal({ computed_at: T + 1000, median: 0.9 }));
    const r = readLatestCalibration(db, "main");
    expect(r?.median).toBe(0.9);
    // History survives — "did this vault's distribution shift when the engine changed?" needs it.
    const all = db.prepare("SELECT COUNT(*) n FROM score_calibration").get() as { n: number };
    expect(all.n).toBe(2);
  });

  it("is scoped PER VAULT — the entire point of persisting it", () => {
    persistCalibration(db, cal({ vault_id: "main", median: 0.1 }));
    persistCalibration(db, cal({ vault_id: "docs", median: 0.9 }));
    expect(readLatestCalibration(db, "main")?.median).toBe(0.1);
    expect(readLatestCalibration(db, "docs")?.median).toBe(0.9);
    expect(readLatestCalibration(db, "never-calibrated")).toBeNull();
  });
});
