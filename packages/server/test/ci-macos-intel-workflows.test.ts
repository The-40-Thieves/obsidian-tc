import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The Intel macOS legs must run on every PR, server-only changes included. ci-native.yml is
// path-filtered (packages/native/**, its own file, publish.yml, setup-rust), so the Intel
// native-addon job lives in ci-server.yml, which has no filter. The macos-14 entries are
// REQUIRED check names: adding Intel entries must never rename or drop them.

const WORKFLOWS = join(resolve(import.meta.dirname, "..", "..", ".."), ".github", "workflows");
const read = (name: string) => readFileSync(join(WORKFLOWS, name), "utf8");

interface Matrix {
  include?: Record<string, string>[];
  host?: string[];
}
interface Job {
  "runs-on"?: string;
  strategy?: { matrix: Matrix };
}
interface Workflow {
  on: Record<string, { paths?: unknown } | null>;
  jobs: Record<string, Job>;
}

const serverText = read("ci-server.yml");
const nativeText = read("ci-native.yml");
const server = parse(serverText) as Workflow;
const native = parse(nativeText) as Workflow;

describe("macOS Intel legs in CI", () => {
  it("ci-server.yml has no paths filter on any trigger, so a server-only change runs the Intel legs", () => {
    for (const [event, cfg] of Object.entries(server.on)) {
      expect(cfg?.paths, `ci-server.yml ${event}`).toBeUndefined();
    }
  });

  it("the Intel native-addon job runs in ci-server.yml on both Intel labels, not in the filtered ci-native.yml", () => {
    const job = server.jobs["macos-intel-native-server-tests"];
    expect(job?.strategy?.matrix.host).toEqual(["macos-15-intel", "macos-26-intel"]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
    expect(job?.["runs-on"]).toBe("${{ matrix.host }}");
    expect(native.jobs["macos-intel-native-server-tests"]).toBeUndefined();
    expect(serverText).toContain("compiled addon did NOT load");
  });

  it("build-test runs both Intel labels on Node 26", () => {
    const include = server.jobs["build-test"]?.strategy?.matrix.include ?? [];
    expect(include).toContainEqual({ os: "macos-15-intel", node: "26" });
    expect(include).toContainEqual({ os: "macos-26-intel", node: "26" });
  });

  it("embed-codegen runs darwin-x64 on both Intel labels", () => {
    const include = server.jobs["embed-codegen"]?.strategy?.matrix.include ?? [];
    expect(include).toContainEqual({ os: "macos-15-intel", target: "bun-darwin-x64" });
    expect(include).toContainEqual({ os: "macos-26-intel", target: "bun-darwin-x64" });
  });

  it("the native build matrix builds x86_64-apple-darwin natively on both Intel labels", () => {
    const include = native.jobs.build?.strategy?.matrix.include ?? [];
    expect(include).toContainEqual({
      host: "macos-15-intel",
      target: "x86_64-apple-darwin",
      triple: "darwin-x64",
    });
    expect(include).toContainEqual({
      host: "macos-26-intel",
      target: "x86_64-apple-darwin",
      triple: "darwin-x64",
    });
  });

  it("the macos-14 entries are unchanged (required check names must not move)", () => {
    expect(native.jobs.build?.strategy?.matrix.include).toContainEqual({
      host: "macos-14",
      target: "aarch64-apple-darwin",
      triple: "darwin-arm64",
    });
    expect(native.jobs["macos-native-server-tests"]?.["runs-on"]).toBe("macos-14");
    expect(server.jobs["embed-codegen"]?.strategy?.matrix.include).toContainEqual({
      os: "macos-14",
      target: "bun-darwin-arm64",
    });
  });
});
