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
  strategy?: { matrix?: { node?: string[]; os?: string[]; include?: Record<string, string>[] } };
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

describe("macOS Intel Vitest timeout floor", () => {
  const FLOOR_KEY = "vitest-timeout-floor-ms";
  const FLOOR_EXPRESSION = `\${{ matrix.${FLOOR_KEY} }}`;

  it("sets the floor on both Intel build-test legs through the matrix and on no other leg", () => {
    const include = readWorkflow("ci-server.yml").jobs?.["build-test"]?.strategy?.matrix?.include;
    const floored = (include ?? [])
      .filter((leg) => leg[FLOOR_KEY] !== undefined)
      .map((leg) => [leg.os, leg[FLOOR_KEY]]);
    expect(floored).toEqual([
      ["macos-15-intel", "15000"],
      ["macos-26-intel", "15000"],
    ]);

    const serverSuite = readWorkflow("ci-server.yml").jobs?.["build-test"]?.steps?.find(
      (step) =>
        step["working-directory"] === "packages/server" &&
        step.run?.includes("node ./node_modules/vitest/vitest.mjs run"),
    );
    expect(serverSuite?.env?.VITEST_TIMEOUT_FLOOR_MS).toBe(FLOOR_EXPRESSION);
  });

  it("sets the floor on the Intel native server-tests step", () => {
    const job = readWorkflow("ci-server.yml").jobs?.["macos-intel-native-server-tests"];
    const suite = job?.steps?.find(
      (step) =>
        step["working-directory"] === "packages/server" &&
        step.run?.includes("node ./node_modules/vitest/vitest.mjs run"),
    );
    expect(suite?.env?.VITEST_TIMEOUT_FLOOR_MS).toBe("15000");
  });

  it("sets VITEST_TIMEOUT_FLOOR_MS in exactly the two Intel vitest jobs and nowhere else", () => {
    const occurrences: string[] = [];
    for (const workflowName of readdirSync(WORKFLOWS).filter((name) => name.endsWith(".yml"))) {
      const workflow = readWorkflow(workflowName);
      for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
        if (job.env?.VITEST_TIMEOUT_FLOOR_MS !== undefined)
          occurrences.push(`${workflowName}:${jobName}`);
        for (const step of job.steps ?? []) {
          if (step.env?.VITEST_TIMEOUT_FLOOR_MS !== undefined)
            occurrences.push(`${workflowName}:${jobName}`);
        }
      }
    }

    expect(occurrences).toEqual([
      "ci-server.yml:build-test",
      "ci-server.yml:macos-intel-native-server-tests",
    ]);
  });
});
