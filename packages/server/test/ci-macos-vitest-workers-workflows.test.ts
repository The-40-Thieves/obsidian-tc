import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOWS = join(resolve(import.meta.dirname, "..", "..", ".."), ".github", "workflows");
// biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
const WORKER_EXPRESSION = "${{ matrix.os == 'macos-latest' && '2' || '' }}";

interface Step {
  name?: string;
  env?: Record<string, string>;
  run?: string;
  "working-directory"?: string;
}

interface Job {
  env?: Record<string, string>;
  strategy?: { matrix?: { node?: string[]; os?: string[] } };
  steps?: Step[];
}

interface Workflow {
  jobs?: Record<string, Job>;
}

const readWorkflow = (name: string): Workflow =>
  parse(readFileSync(join(WORKFLOWS, name), "utf8")) as Workflow;

describe("macos-latest Vitest worker cap", () => {
  it("sets two workers on both macos-latest build-test legs and leaves every other leg uncapped", () => {
    const buildTest = readWorkflow("ci-server.yml").jobs?.["build-test"];
    expect(buildTest?.strategy?.matrix?.os).toContain("macos-latest");
    expect(buildTest?.strategy?.matrix?.node).toEqual(["26", "24"]);

    const serverSuite = buildTest?.steps?.find(
      (step) =>
        step["working-directory"] === "packages/server" &&
        step.run?.includes("node ./node_modules/vitest/vitest.mjs run"),
    );
    expect(serverSuite?.env?.VITEST_MAX_WORKERS).toBe(WORKER_EXPRESSION);
  });

  it("does not set VITEST_MAX_WORKERS in any other workflow job or step", () => {
    const occurrences: string[] = [];
    for (const workflowName of readdirSync(WORKFLOWS).filter((name) => name.endsWith(".yml"))) {
      const workflow = readWorkflow(workflowName);
      for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
        if (job.env?.VITEST_MAX_WORKERS !== undefined)
          occurrences.push(`${workflowName}:${jobName}`);
        for (const step of job.steps ?? []) {
          if (step.env?.VITEST_MAX_WORKERS !== undefined)
            occurrences.push(`${workflowName}:${jobName}:${step.name ?? "unnamed"}`);
        }
      }
    }

    expect(occurrences).toEqual([
      "ci-server.yml:build-test:test server (vitest under Node; coverage gate on Linux, Node 26)",
    ]);
  });
});
