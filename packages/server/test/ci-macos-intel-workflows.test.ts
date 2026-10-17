import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { eventGate, eventGatedList, PR_EVENT_CONDITION } from "./ci-intel-event-gate";

// The macOS Intel legs run on push to main, on the nightly schedule and on workflow_dispatch, not on
// pull_request or merge_group: the hosted macOS Intel concurrency is small, and the Intel legs queued
// the required macos-latest legs behind them. The macos-15 entries are REQUIRED check names: adding
// or gating Intel entries must never rename or drop them.

const WORKFLOWS = join(resolve(import.meta.dirname, "..", "..", ".."), ".github", "workflows");
const read = (name: string) => readFileSync(join(WORKFLOWS, name), "utf8");
const load = (name: string) => parse(read(name)) as Workflow;

const TABLE_OSES_ENV = "FR_OSES";
const INTEL_HOSTS = ["macos-15-intel", "macos-26-intel"];
const NIGHTLY = "17 6 * * *";
const NOT_ON_PR_OR_QUEUE =
  "github.event_name != 'pull_request' && github.event_name != 'merge_group'";
const TOUCHED = [
  "ci-server.yml",
  "ci-native.yml",
  "ci-install-smoke.yml",
  "ci-first-run-smoke.yml",
];

interface Step {
  env?: Record<string, string>;
  run?: string;
}
interface Matrix {
  host?: string[];
  os?: unknown;
  include?: unknown;
}
interface Job {
  "runs-on"?: string;
  if?: string;
  needs?: unknown;
  strategy?: { matrix: Matrix };
  steps?: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
}

const server = load("ci-server.yml");
const native = load("ci-native.yml");
const install = load("ci-install-smoke.yml");
const firstRun = load("ci-first-run-smoke.yml");

describe("macOS Intel legs in CI", () => {
  it("ci-server.yml has no paths filter on any trigger, so a server-only change runs the Intel legs", () => {
    for (const [event, cfg] of Object.entries(server.on)) {
      expect((cfg as { paths?: unknown } | null)?.paths, `ci-server.yml ${event}`).toBeUndefined();
    }
  });

  it("the Intel native-addon job runs in ci-server.yml on both Intel labels, not in the filtered ci-native.yml", () => {
    const job = server.jobs["macos-intel-native-server-tests"];
    expect(job?.strategy?.matrix.host).toEqual(INTEL_HOSTS);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
    expect(job?.["runs-on"]).toBe("${{ matrix.host }}");
    expect(native.jobs["macos-intel-native-server-tests"]).toBeUndefined();
    expect(read("ci-server.yml")).toContain("compiled addon did NOT load");
  });

  it("build-test runs both Intel labels on Node 26 when the event is not a PR", () => {
    const { otherEvents } = eventGatedList(server.jobs["build-test"]?.strategy?.matrix.include);
    expect(otherEvents).toContainEqual({
      os: "macos-15-intel",
      node: "26",
      "vitest-timeout-floor-ms": "15000",
    });
    expect(otherEvents).toContainEqual({
      os: "macos-26-intel",
      node: "26",
      "vitest-timeout-floor-ms": "15000",
    });
  });

  it("embed-codegen runs darwin-x64 on both Intel labels when the event is not a PR", () => {
    const { otherEvents } = eventGatedList(server.jobs["embed-codegen"]?.strategy?.matrix.include);
    expect(otherEvents).toContainEqual({ os: "macos-15-intel", target: "bun-darwin-x64" });
    expect(otherEvents).toContainEqual({ os: "macos-26-intel", target: "bun-darwin-x64" });
  });

  it("the native build matrix builds x86_64-apple-darwin natively on both Intel labels when the event is not a PR", () => {
    const { otherEvents } = eventGatedList(native.jobs.build?.strategy?.matrix.include);
    expect(otherEvents).toContainEqual({
      host: "macos-15-intel",
      target: "x86_64-apple-darwin",
      triple: "darwin-x64",
    });
    expect(otherEvents).toContainEqual({
      host: "macos-26-intel",
      target: "x86_64-apple-darwin",
      triple: "darwin-x64",
    });
  });

  it("the macos-15 entries are unchanged on every event (required check names must not move)", () => {
    const native15 = { host: "macos-15", target: "aarch64-apple-darwin", triple: "darwin-arm64" };
    const embed15 = { os: "macos-15", target: "bun-darwin-arm64" };
    expect(
      eventGatedList(native.jobs.build?.strategy?.matrix.include).onPullRequest,
    ).toContainEqual(native15);
    expect(eventGatedList(native.jobs.build?.strategy?.matrix.include).otherEvents).toContainEqual(
      native15,
    );
    expect(
      eventGatedList(server.jobs["embed-codegen"]?.strategy?.matrix.include).onPullRequest,
    ).toContainEqual(embed15);
    expect(native.jobs["macos-native-server-tests"]?.["runs-on"]).toBe("macos-15");
  });
});

describe("macOS Intel legs: event gating and nightly schedule", () => {
  const gated: [string, unknown][] = [
    ["ci-server.yml build-test include", server.jobs["build-test"]?.strategy?.matrix.include],
    ["ci-server.yml embed-codegen include", server.jobs["embed-codegen"]?.strategy?.matrix.include],
    ["ci-native.yml build include", native.jobs.build?.strategy?.matrix.include],
    ["ci-install-smoke.yml install-smoke os", install.jobs["install-smoke"]?.strategy?.matrix.os],
    ["ci-first-run-smoke.yml first-run os", firstRun.jobs["first-run"]?.strategy?.matrix.os],
    [
      "ci-first-run-smoke.yml first-run include",
      firstRun.jobs["first-run"]?.strategy?.matrix.include,
    ],
  ];

  it.each(gated)(
    "%s keeps the Intel hosts out of the pull_request and merge_group list only",
    (_name, value) => {
      expect(eventGate(value).condition).toBe(PR_EVENT_CONDITION);
      const { onPullRequest, otherEvents } = eventGatedList(value);
      expect(JSON.stringify(onPullRequest)).not.toMatch(/-intel/);
      for (const host of INTEL_HOSTS) expect(JSON.stringify(otherEvents)).toContain(host);
    },
  );

  it("the Intel native-addon job is skipped on pull_request and merge_group", () => {
    expect(server.jobs["macos-intel-native-server-tests"]?.if).toBe(NOT_ON_PR_OR_QUEUE);
  });

  it.each(TOUCHED)("%s runs nightly", (name) => {
    expect(load(name).on.schedule).toEqual([{ cron: NIGHTLY }]);
  });

  it("the first-run table lists the OSes its matrix runs on, for each event", () => {
    const { onPullRequest, otherEvents } = eventGatedList(
      firstRun.jobs["first-run"]?.strategy?.matrix.os,
    );
    const table = firstRun.jobs.matrix?.steps?.find((step) => step.env?.[TABLE_OSES_ENV]);
    expect(table, "matrix job step that passes the table OS list").toBeDefined();
    const gate = eventGate(table?.env?.[TABLE_OSES_ENV]);
    expect(gate.condition).toBe(PR_EVENT_CONDITION);
    expect(gate.onPullRequest.split(",")).toEqual(onPullRequest);
    expect(gate.otherEvents.split(",")).toEqual(otherEvents);
    expect(table?.run).toContain(`"$${TABLE_OSES_ENV}"`);
  });
});
