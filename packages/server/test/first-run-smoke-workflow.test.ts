import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseExpectedFailures } from "../scripts/lib/first-run-smoke-lib.mjs";

// The first-run matrix workflow records today's failures through an explicit EXPECTED_FAILURES
// list. These tests keep that list honest: it may only name real matrix cells, and the exemption
// must sit on the smoke STEP, because a job-level continue-on-error does not survive a failed step.

const WORKFLOW = join(
  resolve(import.meta.dirname, "..", "..", ".."),
  ".github",
  "workflows",
  "ci-first-run-smoke.yml",
);
const text = readFileSync(WORKFLOW, "utf8");
interface Step {
  id?: string;
  name?: string;
  run?: string;
  "continue-on-error"?: unknown;
}
const wf = parse(text) as {
  env: { EXPECTED_FAILURES: string };
  jobs: Record<
    string,
    {
      "continue-on-error"?: unknown;
      strategy?: { matrix: { path: string[]; os: string[] } };
      steps: Step[];
    }
  >;
};
const job = wf.jobs["first-run"];

describe("ci-first-run-smoke.yml", () => {
  it("is a 3 paths x 3 operating systems matrix", () => {
    expect(job?.strategy?.matrix.path).toEqual(["npm", "mcpb", "binary"]);
    expect(job?.strategy?.matrix.os).toEqual(["ubuntu-latest", "macos-latest", "windows-latest"]);
  });

  it("EXPECTED_FAILURES names only real matrix cells, each once", () => {
    const { path, os } = job?.strategy?.matrix ?? { path: [], os: [] };
    const cells = new Set(path.flatMap((p) => os.map((o) => `${p}/${o}`)));
    const listed = wf.env.EXPECTED_FAILURES.split(/\s+/).filter(Boolean);
    expect(new Set(listed).size, "duplicate entry in EXPECTED_FAILURES").toBe(listed.length);
    for (const cell of listed) expect(cells.has(cell), `${cell} is not a matrix cell`).toBe(true);
    expect([...parseExpectedFailures(wf.env.EXPECTED_FAILURES)].sort()).toEqual([...listed].sort());
  });

  it("no job carries a job-level continue-on-error", () => {
    for (const [name, j] of Object.entries(wf.jobs)) {
      expect(j["continue-on-error"], `job ${name}`).toBeUndefined();
    }
  });

  it("the exemption is step-level on the smoke step and keyed on the expected-failure list", () => {
    const smoke = job?.steps.find((s) => s.id === "smoke");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
    expect(smoke?.["continue-on-error"]).toBe("${{ steps.expect.outputs.expected == 'true' }}");
    const expect_ = job?.steps.find((s) => s.id === "expect");
    expect(expect_?.run).toContain('" $EXPECTED_FAILURES " == *" $FR_PATH/$FR_OS "*');
    // The only continue-on-error in the file is that one step.
    expect(text.match(/^\s*continue-on-error:/gm)).toHaveLength(1);
  });

  it("the summary job's path and os lists match the matrix", () => {
    const { path, os } = job?.strategy?.matrix ?? { path: [], os: [] };
    expect(text).toContain(`"${path.join(",")}" "${os.join(",")}"`);
  });

  it("the report upload runs even when the smoke step failed", () => {
    const upload = job?.steps.find((s) =>
      (s as { uses?: string }).uses?.startsWith("actions/upload-artifact"),
    );
    expect((upload as { if?: string }).if).toBe("always()");
  });
});
