import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const ACTION_PATH = join(ROOT, ".github", "actions", "macos-hostname", "action.yml");
const WORKFLOWS = join(ROOT, ".github", "workflows");
const HOSTNAME_ACTION = "./.github/actions/macos-hostname";

interface Step {
  if?: string;
  uses?: string;
  run?: string;
  "continue-on-error"?: boolean;
}

interface Workflow {
  jobs: Record<string, { steps: Step[] }>;
}

const readWorkflow = (name: string): Workflow =>
  parse(readFileSync(join(WORKFLOWS, name), "utf8")) as Workflow;

describe("hosted macOS hostname workaround", () => {
  it("defines a composite action with public upstream context and order-independent diagnostics", () => {
    expect(existsSync(ACTION_PATH), "macOS hostname action").toBe(true);

    const text = readFileSync(ACTION_PATH, "utf8");
    const action = parse(text) as {
      description: string;
      runs: { using: string; steps: Step[] };
    };

    expect(text).toContain("https://github.com/actions/runner-images/issues/14568");
    expect(text).toContain("https://github.com/actions/runner-images/issues/12562");
    expect(action.runs.using).toBe("composite");
    expect(action.description).toContain("dscacheutil");
    expect(action.runs.steps).toHaveLength(3);
    for (const step of action.runs.steps) expect(step.if).toBe("runner.os == 'macOS'");

    const [before, configure, after] = action.runs.steps;
    expect(before["continue-on-error"]).toBe(true);
    expect(before.run).toContain("hostname lookup before:");
    expect(before.run).toContain("sleep 60");
    expect(before.run).toContain('kill -KILL "$lookup_pid"');
    expect(configure["continue-on-error"]).toBeUndefined();
    expect(configure.run).toContain("sudo scutil --set HostName ci-mac");
    expect(configure.run).toContain("sudo scutil --set LocalHostName ci-mac");
    expect(configure.run).toContain("sudo scutil --set ComputerName ci-mac");
    expect(after["continue-on-error"]).toBe(true);
    expect(after.run).toContain("hostname lookup after:");
    expect(after.run).toContain('kill -KILL "$lookup_pid"');
  });

  it("runs immediately after checkout in every macOS test or smoke job", () => {
    const targets: Record<string, string[]> = {
      "ci-server.yml": ["build-test", "macos-intel-native-server-tests", "embed-codegen"],
      "ci-native.yml": ["build", "macos-native-server-tests"],
      "ci-first-run-smoke.yml": ["first-run"],
      "ci-install-smoke.yml": ["install-smoke"],
    };

    for (const [workflowName, jobNames] of Object.entries(targets)) {
      const workflow = readWorkflow(workflowName);
      for (const jobName of jobNames) {
        const steps = workflow.jobs[jobName]?.steps ?? [];
        const checkout = steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
        expect(checkout, `${workflowName}:${jobName} checkout`).toBeGreaterThanOrEqual(0);
        expect(steps[checkout + 1]?.uses, `${workflowName}:${jobName} post-checkout action`).toBe(
          HOSTNAME_ACTION,
        );
      }
    }
  });
});
