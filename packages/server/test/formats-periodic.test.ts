import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ObsidianTcError } from "@obsidian-tc/shared";
import { describe, expect, it } from "vitest";
import {
  formatMoment,
  isoWeek,
  parseDateInput,
  resolvePeriodicConfig,
  resolvePeriodicPath,
  toISODate,
} from "../src/formats/periodic";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as ObsidianTcError).code;
  }
  throw new Error("expected a throw");
}

const d = (iso: string): Date => parseDateInput(iso);

describe("formats/periodic resolver", () => {
  it("formats common moment tokens", () => {
    expect(formatMoment(d("2024-05-09"), "YYYY-MM-DD")).toBe("2024-05-09");
    expect(formatMoment(d("2024-05-09"), "YYYY/MM/DD")).toBe("2024/05/09");
    expect(formatMoment(d("2024-05-09"), "M-D")).toBe("5-9");
    expect(formatMoment(d("2024-05-09"), "MMMM YY")).toBe("May 24");
    expect(formatMoment(d("2024-05-09"), "MMM")).toBe("May");
    expect(formatMoment(d("2024-05-15"), "YYYY-[Q]Q")).toBe("2024-Q2");
    expect(formatMoment(d("2024-05-15"), "YYYY-MM")).toBe("2024-05");
  });

  it("formats ordinals", () => {
    expect(formatMoment(d("2024-05-01"), "Do")).toBe("1st");
    expect(formatMoment(d("2024-05-02"), "Do")).toBe("2nd");
    expect(formatMoment(d("2024-05-11"), "Do")).toBe("11th");
    expect(formatMoment(d("2024-05-21"), "Do")).toBe("21st");
  });

  it("computes ISO week numbers across year boundaries", () => {
    expect(isoWeek(d("2020-12-31"))).toEqual({ week: 53, year: 2020 });
    expect(isoWeek(d("2021-01-01"))).toEqual({ week: 53, year: 2020 });
    expect(isoWeek(d("2021-01-04"))).toEqual({ week: 1, year: 2021 });
    expect(isoWeek(d("2018-12-31"))).toEqual({ week: 1, year: 2019 });
    expect(isoWeek(d("2023-01-01"))).toEqual({ week: 52, year: 2022 });
    expect(formatMoment(d("2021-01-01"), "gggg-[W]ww")).toBe("2020-W53");
  });

  it("validates date input", () => {
    expect(toISODate(d("2024-02-29"))).toBe("2024-02-29");
    expect(codeOf(() => parseDateInput("not-a-date"))).toBe("invalid_input");
    expect(codeOf(() => parseDateInput("2024-13-40"))).toBe("invalid_input");
    expect(codeOf(() => parseDateInput("2023-02-29"))).toBe("invalid_input");
  });

  it("falls back to Obsidian defaults when no config is present", () => {
    const root = mkdtempSync(join(tmpdir(), "obtc-pn-"));
    try {
      const r = resolvePeriodicConfig(root, "daily");
      expect(r.source).toBe("default");
      expect(r.config.format).toBe("YYYY-MM-DD");
      expect(resolvePeriodicPath(root, "daily", d("2024-05-09")).path).toBe("2024-05-09.md");
      expect(resolvePeriodicPath(root, "weekly", d("2021-01-01")).path).toBe("2020-W53.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors the periodic-notes plugin config (format + folder)", () => {
    const root = mkdtempSync(join(tmpdir(), "obtc-pn-"));
    try {
      const cfg = join(root, ".obsidian", "plugins", "periodic-notes", "data.json");
      mkdirSync(dirname(cfg), { recursive: true });
      writeFileSync(cfg, JSON.stringify({ daily: { format: "YYYY/MM/DD", folder: "Journal" } }));
      const r = resolvePeriodicConfig(root, "daily");
      expect(r.source).toBe("periodic-notes");
      expect(resolvePeriodicPath(root, "daily", d("2024-05-09")).path).toBe(
        "Journal/2024/05/09.md",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors the daily-notes core plugin config as a daily fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "obtc-pn-"));
    try {
      const dir = join(root, ".obsidian");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "daily-notes.json"),
        JSON.stringify({ format: "DD-MM-YYYY", folder: "Daily" }),
      );
      const r = resolvePeriodicConfig(root, "daily");
      expect(r.source).toBe("daily-notes");
      expect(resolvePeriodicPath(root, "daily", d("2024-05-09")).path).toBe("Daily/09-05-2024.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
