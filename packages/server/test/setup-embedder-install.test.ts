// `obsidian-tc setup` offers to install the local embedder package. It is no longer an
// optionalDependency of obsidian-tc, so a plain `npm i obsidian-tc` leaves it out and setup is the
// place that asks. Every install is injected (run_setup's second argument), so no test runs a real
// npm/bun; the planner is pure and tested directly.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { version } from "../package.json";
import { run_setup } from "../src/cli/commands/setup";
import {
  EMBEDDER_PACKAGE,
  type EmbedderInstallPlan,
  embedderInstallCommand,
  planEmbedderInstall,
} from "../src/cli/setup/embedder-install";
import { probeLocalEmbedderResolution } from "../src/providers/local-embedder-registry";
import { makeTempDir, rmTemp, stubHomedir } from "./tmp";

vi.mock("../src/providers/local-embedder-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/providers/local-embedder-registry")>()),
  probeLocalEmbedderResolution: vi.fn(),
}));
vi.mock("../src/providers/reranker-preflight", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/providers/reranker-preflight")>()),
  onnxNativePrebuildStatus: vi.fn(() => ({ supported: true })),
}));

type Probe = Awaited<ReturnType<typeof probeLocalEmbedderResolution>>;
const SPEC = `${EMBEDDER_PACKAGE}@${version}`;
const missing = { ok: false, attempts: [], inSourceCheckout: false } as Probe;
const resolved = {
  ok: true,
  route: "bare-specifier",
  attempts: [],
  inSourceCheckout: false,
} as Probe;

const npmPlan: EmbedderInstallPlan = {
  manager: "npm",
  cwd: "/home/u/proj",
  global: false,
  argv: ["install", "--save-exact", SPEC],
};
const bunPlan: EmbedderInstallPlan = {
  manager: "bun",
  cwd: "/home/u/proj",
  global: false,
  argv: ["add", "--exact", SPEC],
};

const tmpDirs: string[] = [];
let restoreHome: (() => void) | undefined;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  // No Ollama in these tests, whatever is running on the host.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("ECONNREFUSED (stubbed)"))),
  );
  vi.mocked(probeLocalEmbedderResolution).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  restoreHome?.();
  restoreHome = undefined;
  for (const d of tmpDirs.splice(0)) rmTemp(d);
});

/** A temp home with a vault directory, so detect() never reads the real host's registry. */
function sandbox(): { configPath: string; vaultPath: string } {
  const home = makeTempDir("otc-setup-embedder-home-");
  const vaultPath = makeTempDir("otc-setup-embedder-vault-");
  tmpDirs.push(home, vaultPath);
  restoreHome = stubHomedir(home);
  mkdirSync(join(home, ".obsidian-tc"), { recursive: true });
  writeFileSync(join(home, ".obsidian-tc", "placeholder"), "");
  return { configPath: join(home, ".obsidian-tc", "config.json"), vaultPath };
}

function cmd(vaultPath: string, configPath: string) {
  return {
    kind: "setup" as const,
    yes: false,
    dryRun: false,
    force: false,
    vaultPath,
    configPath,
  };
}

const out = () => stdout.join("");
const err = () => stderr.join("");

describe("planEmbedderInstall — which package manager and prefix", () => {
  const proj = join("/home/u/proj");
  const pkgDir = join(proj, "node_modules", "obsidian-tc");
  const inProject = (name: string) => (p: string) => p === join(proj, name);

  it("npm in a local project runs in that project with an exact pin", () => {
    expect(
      planEmbedderInstall({
        version,
        pkgDir,
        userAgent: "npm/10.8.0 node/v24.1.0",
        exists: inProject("package.json"),
      }),
    ).toEqual({
      manager: "npm",
      cwd: proj,
      global: false,
      argv: ["install", "--save-exact", SPEC],
    });
  });

  it("the invoking bun wins over the lockfile and adds with --exact", () => {
    expect(
      planEmbedderInstall({
        version,
        pkgDir,
        userAgent: "bun/1.4.3 npm/? node/v24.1.0",
        exists: inProject("package.json"),
      }),
    ).toMatchObject({ manager: "bun", cwd: proj, argv: ["add", "--exact", SPEC] });
  });

  it("pnpm from the user agent", () => {
    expect(
      planEmbedderInstall({
        version,
        pkgDir,
        userAgent: "pnpm/9.12.0 npm/? node/v24.1.0",
        exists: inProject("package.json"),
      }),
    ).toMatchObject({ manager: "pnpm", argv: ["add", "--save-exact", SPEC] });
  });

  it("with no user agent, a bun.lock in the project selects bun", () => {
    expect(
      planEmbedderInstall({
        version,
        pkgDir,
        exists: (p) => p === join(proj, "package.json") || p === join(proj, "bun.lock"),
      }),
    ).toMatchObject({ manager: "bun", argv: ["add", "--exact", SPEC] });
  });

  it("a global npm install (no package.json above node_modules) installs globally", () => {
    const globalDir = join("/usr", "lib", "node_modules", "obsidian-tc");
    const plan = planEmbedderInstall({
      version,
      pkgDir: globalDir,
      userAgent: "npm/10.8.0 node/v24.1.0",
      exists: () => false,
    });
    expect(plan).toEqual({
      manager: "npm",
      global: true,
      argv: ["install", "--global", SPEC],
    });
    expect(plan?.cwd).toBeUndefined();
  });

  it("a global install by a non-npm manager is not run: the prefix cannot be trusted", () => {
    expect(
      planEmbedderInstall({
        version,
        pkgDir: join("/home/u/.local/share/pnpm", "node_modules", "obsidian-tc"),
        userAgent: "pnpm/9.12.0 npm/? node/v24.1.0",
        exists: () => false,
      }),
    ).toBeUndefined();
  });

  it("an install location that is not a node_modules directory (source checkout, binary) is not run", () => {
    expect(
      planEmbedderInstall({
        version,
        pkgDir: join("/src", "packages", "server"),
        userAgent: "npm/10.8.0",
        exists: () => true,
      }),
    ).toBeUndefined();
  });

  it("embedderInstallCommand prints the exact command the plan runs", () => {
    expect(embedderInstallCommand(npmPlan)).toBe(`npm install --save-exact ${SPEC}`);
    expect(embedderInstallCommand(bunPlan)).toBe(`bun add --exact ${SPEC}`);
  });
});

describe("obsidian-tc setup offers to install the local embedder", () => {
  it("accepted: installs once with the planned argv, then the re-probe drives the decision", async () => {
    const { configPath, vaultPath } = sandbox();
    vi.mocked(probeLocalEmbedderResolution)
      .mockResolvedValueOnce(missing)
      .mockResolvedValue(resolved);
    const ask = vi.fn(async (_question: string) => true);
    const run = vi.fn((_plan: EmbedderInstallPlan) => ({ ok: true as const }));

    await run_setup(cmd(vaultPath, configPath), {
      interactive: true,
      ask,
      plan: () => npmPlan,
      run,
    });

    expect(ask).toHaveBeenCalledTimes(1);
    expect(String(ask.mock.calls[0]?.[0])).toContain(`Install ${SPEC} now? [Y/n]`);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(npmPlan);
    expect(vi.mocked(probeLocalEmbedderResolution)).toHaveBeenCalledTimes(2);
    expect(out()).toContain("provider=local");
    expect(out()).not.toContain("NOTICE");
  });

  it("accepted under bun: the bun add argv is what runs", async () => {
    const { configPath, vaultPath } = sandbox();
    vi.mocked(probeLocalEmbedderResolution)
      .mockResolvedValueOnce(missing)
      .mockResolvedValue(resolved);
    const run = vi.fn((_plan: EmbedderInstallPlan) => ({ ok: true as const }));

    await run_setup(cmd(vaultPath, configPath), {
      interactive: true,
      ask: async () => true,
      plan: () => bunPlan,
      run,
    });

    expect(run).toHaveBeenCalledWith(bunPlan);
    expect(run.mock.calls[0]?.[0].argv).toEqual(["add", "--exact", SPEC]);
  });

  it("declined: no install, the existing local-anyway notice, and the command to run later", async () => {
    const { configPath, vaultPath } = sandbox();
    vi.mocked(probeLocalEmbedderResolution).mockResolvedValue(missing);
    const run = vi.fn((_plan: EmbedderInstallPlan) => ({ ok: true as const }));

    await run_setup(cmd(vaultPath, configPath), {
      interactive: true,
      ask: async () => false,
      plan: () => npmPlan,
      run,
    });

    expect(run).not.toHaveBeenCalled();
    expect(vi.mocked(probeLocalEmbedderResolution)).toHaveBeenCalledTimes(1);
    expect(out()).toContain("NOTICE");
    expect(out()).toContain("could not be confirmed working");
    expect(out()).toContain(`npm install --save-exact ${SPEC}`);
  });

  it("non-interactive: never installs, and prints the exact command instead", async () => {
    const { configPath, vaultPath } = sandbox();
    vi.mocked(probeLocalEmbedderResolution).mockResolvedValue(missing);
    const ask = vi.fn(async (_question: string) => true);
    const run = vi.fn((_plan: EmbedderInstallPlan) => ({ ok: true as const }));

    await run_setup(cmd(vaultPath, configPath), {
      interactive: false,
      ask,
      plan: () => npmPlan,
      run,
    });

    expect(ask).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(out()).toContain(`npm install --save-exact ${SPEC}`);
  });

  it("installer fails: no crash, the error is surfaced, and setup falls back to local-anyway", async () => {
    const { configPath, vaultPath } = sandbox();
    vi.mocked(probeLocalEmbedderResolution).mockResolvedValue(missing);

    await expect(
      run_setup(cmd(vaultPath, configPath), {
        interactive: true,
        ask: async () => true,
        plan: () => npmPlan,
        run: () => ({ ok: false as const, error: "exit 1" }),
      }),
    ).resolves.toBeUndefined();

    expect(err()).toContain("exit 1");
    expect(out()).toContain("NOTICE");
  });

  it("no install prefix can be determined: prints the command, does not ask or run", async () => {
    const { configPath, vaultPath } = sandbox();
    vi.mocked(probeLocalEmbedderResolution).mockResolvedValue(missing);
    const ask = vi.fn(async (_question: string) => true);
    const run = vi.fn((_plan: EmbedderInstallPlan) => ({ ok: true as const }));

    await run_setup(cmd(vaultPath, configPath), {
      interactive: true,
      ask,
      plan: () => undefined,
      run,
    });

    expect(ask).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(out()).toContain(`npm install --save-exact ${SPEC}`);
  });

  it("package already resolves: no prompt and no install at all", async () => {
    const { configPath, vaultPath } = sandbox();
    vi.mocked(probeLocalEmbedderResolution).mockResolvedValue(resolved);
    const ask = vi.fn(async (_question: string) => true);
    const run = vi.fn((_plan: EmbedderInstallPlan) => ({ ok: true as const }));

    await run_setup(cmd(vaultPath, configPath), {
      interactive: true,
      ask,
      plan: () => npmPlan,
      run,
    });

    expect(ask).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(out()).toContain("provider=local");
  });
});
