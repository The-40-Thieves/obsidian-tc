// docgen hand-written-metric-table scan (THE-595 guard case (c)). marker-scan.ts's existing guard
// catches (a) a render target absent from targets.ts and (b) a marker with no renderer, but is
// blind to (c): a table enumerating `obsidian_tc_*` names with NO marker at all — exactly the shape
// docs/G2.4-observability.md had before this ticket, invisible to every prior gate. Uses a
// throwaway repo tree (see docgen-marker-scan.test.ts) rather than this repo's real docs, so the
// case-(c) logic is proven independent of whatever the live catalog currently looks like.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findHandWrittenMetricTables } from "../scripts/docgen/metric-table-scan";

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "obtc-metric-table-scan-"));
  mkdirSync(join(repoRoot, "docs"), { recursive: true });
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

const write = (rel: string, body: string) => writeFileSync(join(repoRoot, rel), body);

describe("findHandWrittenMetricTables (THE-595 case (c))", () => {
  it("flags a hand-written table enumerating >= 3 metrics outside any generated region", () => {
    write(
      "docs/G2.4-observability.md",
      [
        "### Catalog",
        "",
        "| Name | Labels |",
        "| --- | --- |",
        "| `obsidian_tc_tool_calls_total` | `vault` |",
        "| `obsidian_tc_acl_denied_total` | `vault` |",
        "| `obsidian_tc_hitl_elicited_total` | `vault` |",
        "",
      ].join("\n"),
    );
    const { violations } = findHandWrittenMetricTables(repoRoot);
    expect(violations).toEqual([
      {
        file: "docs/G2.4-observability.md",
        metrics: [
          "obsidian_tc_acl_denied_total",
          "obsidian_tc_hitl_elicited_total",
          "obsidian_tc_tool_calls_total",
        ],
      },
    ]);
  });

  it("does NOT flag the same table once it sits inside a generated marker region", () => {
    write(
      "docs/G2.4-observability.md",
      [
        "### Catalog",
        "",
        "<!-- BEGIN GENERATED: metrics-catalog -->",
        "| Name | Labels |",
        "| --- | --- |",
        "| `obsidian_tc_tool_calls_total` | `vault` |",
        "| `obsidian_tc_acl_denied_total` | `vault` |",
        "| `obsidian_tc_hitl_elicited_total` | `vault` |",
        "<!-- END GENERATED: metrics-catalog -->",
        "",
      ].join("\n"),
    );
    const { violations } = findHandWrittenMetricTables(repoRoot);
    expect(violations).toEqual([]);
  });

  it("does NOT flag a single incidental mention in prose (below the catalog threshold)", () => {
    write(
      "docs/G2.4-security.md",
      "Prometheus counter `obsidian_tc_rate_limit_hits_total` increments on refusal.\n",
    );
    const { violations } = findHandWrittenMetricTables(repoRoot);
    expect(violations).toEqual([]);
  });

  it("asserts a non-empty floor: zero total mentions must read as broken, not clean", () => {
    write("docs/plain.md", "nothing metric-shaped here\n");
    const { totalMentions, violations } = findHandWrittenMetricTables(repoRoot);
    expect(totalMentions).toBe(0);
    expect(violations).toEqual([]); // the scan is not wrong to find nothing; the CALLER must gate on totalMentions
  });

  it("counts mentions inside generated regions toward the floor too", () => {
    write("docs/x.md", "<!-- BEGIN GENERATED: y -->\n`obsidian_tc_a`\n<!-- END GENERATED: y -->\n");
    const { totalMentions } = findHandWrittenMetricTables(repoRoot);
    expect(totalMentions).toBe(1);
  });
});

describe("findHandWrittenMetricTables against the real repo (THE-595 regression)", () => {
  // This is the actual proof the ticket asked for: this scan flagged docs/G2.4-observability.md
  // BEFORE it was converted to a generated marker region, and must stay clean now that it is one.
  // Runs in the normal suite (like docgen-coverage.test.ts) rather than only under
  // docgen:render, so a regression is caught by `bun run test`, not just the CI drift gate.
  const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");

  it("the live docs tree carries no hand-written metric catalog outside a generated region", () => {
    const { totalMentions, violations } = findHandWrittenMetricTables(REPO_ROOT);
    expect(totalMentions).toBeGreaterThan(0); // floor: proves the scan actually ran
    expect(violations).toEqual([]);
  });
});
