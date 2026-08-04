// THE-510: the quiet-host calibration reference is keyed by CPU ARCHITECTURE.
//
// The absolute contention check compares a measured calibration median against a committed
// quiet-host median. That comparison is only meaningful on the same silicon. Before this, one
// untagged 15.0ms reference — captured on x64, per `baseline.small.provenance.json` — was applied
// to every host, so cave (ARM64, quiet median ~27ms) reported `contended` at every load level
// forever. Measured 2026-08-04: median held at 27.0–28.7ms, a 6% spread, while load average rose
// 30%. That is the signature of a different CPU, not of contention.
//
// The cost of that one number was not a wrong log line: THE-510 was priced as an infrastructure
// PURCHASE ("a dedicated quiet host — an infrastructure decision, not engineering work in this
// repo") and blocked two other benchmark tickets behind it.
//
// The rule under test is deliberately a pure function, because the rule is the load-bearing part
// and reading a file is not.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { selectArchReference } from "../eval/perf/run";

describe("selectArchReference — an arch-keyed file applies ONLY its own arch", () => {
  const file = {
    byArch: {
      x64: { referenceMs: 15.0, tol: 0.5 },
      arm64: { channels: { cpuMs: 27.0, ioMs: 31.5 } },
    },
  };

  it("returns the entry for the running architecture", () => {
    expect(selectArchReference(file, "x64")).toStrictEqual({ referenceMs: 15.0, tol: 0.5 });
    expect(selectArchReference(file, "arm64")).toStrictEqual({
      channels: { cpuMs: 27.0, ioMs: 31.5 },
    });
  });

  it("returns undefined for an arch with no entry — it NEVER falls through to another's number", () => {
    // The whole defect in one assertion. Falling through is what judged an ARM host against an x64
    // median and reported sustained load that was not there. `undefined` makes the absolute check
    // stand down, leaving the relative CV/max checks — the same posture as a fresh checkout, which
    // is the honest answer when this machine has no committed quiet-host number.
    expect(selectArchReference(file, "riscv64")).toBeUndefined();
    expect(selectArchReference({ byArch: { x64: { referenceMs: 15 } } }, "arm64")).toBeUndefined();
  });

  it("keeps applying an UNTAGGED pre-THE-510 file as-is", () => {
    // Backward compatibility, and it is the correct reading: on the machine that wrote an untagged
    // reference, the reference is right. Refusing it would silently disarm the absolute check for
    // every existing checkout, which is the failure this detector exists to prevent.
    expect(selectArchReference({ referenceMs: 15.0, tol: 0.5 }, "arm64")).toStrictEqual({
      referenceMs: 15.0,
      tol: 0.5,
    });
    expect(selectArchReference({ channels: { cpuMs: 15 } }, "x64")).toStrictEqual({
      channels: { cpuMs: 15 },
    });
  });

  it("treats an empty byArch as arch-keyed-but-absent, not as untagged", () => {
    // `{byArch: {}}` is a file that HAS been migrated and simply has no entry yet. It must not be
    // read as untagged and fall back to the top level, which would be an empty reference anyway —
    // but the distinction matters for the stderr notice the loader emits.
    expect(selectArchReference({ byArch: {} }, "arm64")).toBeUndefined();
  });
});

describe("the committed reference file", () => {
  const committed = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../eval/perf/calibration-reference.json", import.meta.url)),
      "utf8",
    ),
  ) as { byArch?: Record<string, unknown> };

  it("is arch-keyed, so no host is judged against another architecture's median", () => {
    expect(committed.byArch).toBeDefined();
  });

  it("tags the existing reference as x64, which is where provenance says it was captured", () => {
    // baseline.small.provenance.json records host.arch: "x64". The 15.0ms number is that machine's,
    // and mislabelling it would re-create the defect under a new name.
    expect(committed.byArch).toHaveProperty("x64");
  });

  it("does NOT invent an arm64 entry", () => {
    // Deliberate. A quiet-host reference must be captured on a quiet host; cave runs ~42 containers,
    // so recording its median here would bake this box's load in as the ARM definition of "quiet"
    // and permanently blind the absolute check on every ARM machine. Absent is honest; invented is
    // worse than missing, because it looks measured.
    expect(committed.byArch).not.toHaveProperty("arm64");
  });
});
