// doctor and setup read nothing the hardware enricher produces (doctor uses `profile.obsidian` and
// `profile.runtime`; setup uses `profile.hardware.totalMemMb`, a node:os baseline field), so neither
// may start it. On Windows `systeminformation` starts powershell.exe, which hardware.ts abandons
// after 2 s but which the CLI process still waits on: every spawned `doctor` / `setup` child paid
// for a probe whose answer nobody read, and the `compact-cli` / `doctor-cli-bundle` children that
// run `doctor` hit their 60 s kill budget on a contended windows-latest runner.
// hardware-probe-stub-setup.ts keeps the probe out of THIS process; it cannot reach a child. This
// file counts the calls instead, in-process, so the guarantee holds on every platform.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ calls: 0 }));

vi.mock("systeminformation", () => {
  const si = {
    cpu: async () => {
      probe.calls++;
      return { manufacturer: "Test", brand: "CPU" };
    },
    graphics: async () => {
      probe.calls++;
      return { controllers: [] };
    },
  };
  return { ...si, default: si };
});

import { run_doctor } from "../src/cli/commands/doctor";
import { detect } from "../src/cli/commands/setup";
import { makeTempDir, rmTemp, stubHomedir } from "./tmp";

let root: string;
let restoreHome: () => void;

beforeEach(() => {
  probe.calls = 0;
  root = makeTempDir("obtc-no-hw-probe-");
  restoreHome = stubHomedir(join(root, "home"));
});

afterEach(() => {
  restoreHome();
  rmTemp(root);
  vi.restoreAllMocks();
});

function writeConfig(): string {
  const vault = join(root, "vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "a.md"), "hello");
  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ cacheDir: join(root, "cache"), vaults: [{ id: "main", path: vault }] }),
  );
  return configPath;
}

describe("the hardware enricher is not started by commands that never read it", () => {
  it("doctor does not run the systeminformation probe", async () => {
    const configPath = writeConfig();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // Doctor exits 1 on an overall "fail"; the exit code is not what is asserted here.
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await run_doctor({ kind: "doctor", configPath, json: true });
    expect(probe.calls).toBe(0);
  });

  it("setup detection does not run the systeminformation probe", async () => {
    const configPath = writeConfig();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await detect({ kind: "setup", configPath } as Parameters<typeof detect>[0]);
    expect(probe.calls).toBe(0);
  });
});
