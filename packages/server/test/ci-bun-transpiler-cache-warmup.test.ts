import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");
const WARM_SCRIPT = join(ROOT, "packages", "server", "scripts", "warm-bun-cache.mjs");
const HOME_SETUP = join(ROOT, "packages", "server", "test", "home-isolation-setup.ts");
const WARM_STEP = "pre-warm shared Bun runtime transpiler cache";

interface Step {
  name?: string;
  run?: string;
  "working-directory"?: string;
}

interface Workflow {
  jobs: Record<string, { steps: Step[] }>;
}

const readWorkflow = (name: string): Workflow =>
  parse(readFileSync(join(WORKFLOWS, name), "utf8")) as Workflow;

describe("shared Bun runtime transpiler cache warm-up", () => {
  it("runs immediately before Vitest in every job whose selected tests spawn Bun children", () => {
    const targets: Record<string, string[]> = {
      "ci-server.yml": ["build-test", "redis-ratelimit"],
      "ci-native.yml": ["fallback-test"],
    };

    for (const [workflowName, jobNames] of Object.entries(targets)) {
      const workflow = readWorkflow(workflowName);
      for (const jobName of jobNames) {
        const steps = workflow.jobs[jobName]?.steps ?? [];
        const warm = steps.findIndex((step) => step.name === WARM_STEP);
        const vitest = steps.findIndex((step) => step.run?.includes("vitest.mjs run"));
        expect(warm, `${workflowName}:${jobName} warm step`).toBeGreaterThanOrEqual(0);
        expect(vitest, `${workflowName}:${jobName} vitest step`).toBeGreaterThanOrEqual(0);
        expect(warm, `${workflowName}:${jobName} warm step order`).toBe(vitest - 1);
        expect(steps[warm]?.run).toBe("node scripts/warm-bun-cache.mjs");
        expect(steps[warm]?.["working-directory"]).toBe("packages/server");
      }
    }
  });

  it("does not warm targeted server jobs whose selected tests spawn no Bun children", () => {
    const targets: Record<string, string[]> = {
      "ci-server.yml": ["macos-intel-native-server-tests", "acl-audit", "native-contract"],
      "ci-native.yml": ["macos-native-server-tests"],
    };

    for (const [workflowName, jobNames] of Object.entries(targets)) {
      const workflow = readWorkflow(workflowName);
      for (const jobName of jobNames) {
        const steps = workflow.jobs[jobName]?.steps ?? [];
        expect(
          steps.some((step) => step.name === WARM_STEP),
          `${workflowName}:${jobName} warm step`,
        ).toBe(false);
      }
    }
  });

  it("uses the same shared cache-path helper as the Vitest setup", () => {
    expect(existsSync(WARM_SCRIPT), "warm script exists").toBe(true);
    const warmScript = readFileSync(WARM_SCRIPT, "utf8");
    const homeSetup = readFileSync(HOME_SETUP, "utf8");
    for (const source of [warmScript, homeSetup]) {
      expect(source).toContain("sharedBunRuntimeTranspilerCachePath");
    }
    expect(warmScript).toContain("BUN_RUNTIME_TRANSPILER_CACHE_PATH");
  });
});
