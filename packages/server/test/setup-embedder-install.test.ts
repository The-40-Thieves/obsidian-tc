// `obsidian-tc setup` offers to install the local embedder package. It is no longer an
// optionalDependency of obsidian-tc, so a plain `npm i obsidian-tc` leaves it out and setup is the
// place that asks. Every install is injected (run_setup's second argument), so no test runs a real
// npm/bun; the planner, the argv builder and the runner's spawn are pure or take an injected spawn.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { version } from "../package.json";
import { run_setup } from "../src/cli/commands/setup";
import {
  EMBEDDER_PACKAGE,
  type EmbedderInstallPlan,
  embedderInstallCommand,
  INSTALL_TIMEOUT_MS,
  invocationFor,
  isYesAnswer,
  ownPackageDir,
  planEmbedderInstall,
  runEmbedderInstall,
  type SpawnFn,
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
const globalPlan: EmbedderInstallPlan = {
  manager: "npm",
  global: true,
  argv: ["install", "--global", SPEC],
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
  const npmGlobal = join("/usr", "lib", "node_modules");

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

  it("a global npm install, where npm reports this directory as its global root, installs globally", () => {
    const plan = planEmbedderInstall({
      version,
      pkgDir: join(npmGlobal, "obsidian-tc"),
      globalRoot: npmGlobal,
      userAgent: "npm/10.8.0 node/v24.1.0",
      exists: () => false,
    });
    expect(plan).toEqual(globalPlan);
    expect(plan?.cwd).toBeUndefined();
  });

  it("a global-looking directory npm does not report as its global root is not run", () => {
    expect(
      planEmbedderInstall({
        version,
        pkgDir: join("/opt", "tools", "node_modules", "obsidian-tc"),
        globalRoot: npmGlobal,
        userAgent: "npm/10.8.0 node/v24.1.0",
        exists: () => false,
      }),
    ).toBeUndefined();
  });

  it("with no global root reported, a directory with no package.json above is not run", () => {
    expect(
      planEmbedderInstall({
        version,
        pkgDir: join(npmGlobal, "obsidian-tc"),
        userAgent: "npm/10.8.0 node/v24.1.0",
        exists: () => false,
      }),
    ).toBeUndefined();
  });

  it("a global install by a non-npm manager is not run: the prefix cannot be trusted", () => {
    expect(
      planEmbedderInstall({
        version,
        pkgDir: join(npmGlobal, "obsidian-tc"),
        globalRoot: npmGlobal,
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

  it("a pnpm store path is never planned, even with a project and a matching npm root", () => {
    const store = join(proj, "node_modules", ".pnpm", "obsidian-tc@1.33.1", "node_modules");
    for (const globalRoot of [undefined, store, join(proj, "node_modules")]) {
      expect(
        planEmbedderInstall({
          version,
          pkgDir: join(store, "obsidian-tc"),
          globalRoot,
          userAgent: "pnpm/9.12.0 npm/? node/v24.1.0",
          exists: () => true,
        }),
      ).toBeUndefined();
    }
  });

  it("a pnpm global install is not planned as an npm global install", () => {
    expect(
      planEmbedderInstall({
        version,
        pkgDir: join("/home/u/.local/share/pnpm/global/5/node_modules", "obsidian-tc"),
        globalRoot: npmGlobal,
        userAgent: "npm/10.8.0 node/v24.1.0",
        exists: () => false,
      }),
    ).toBeUndefined();
  });

  it("a Volta tool image is never planned: npm -g would install into Volta's image, not the PATH", () => {
    const image = join("/home/u/.volta/tools/image/packages/obsidian-tc/lib/node_modules");
    expect(
      planEmbedderInstall({
        version,
        pkgDir: join(image, "obsidian-tc"),
        globalRoot: image,
        userAgent: "npm/10.8.0 node/v24.1.0",
        exists: () => false,
      }),
    ).toBeUndefined();
  });

  it("a nested dependency install is not planned: a local install would rewrite the wrapper's package.json", () => {
    expect(
      planEmbedderInstall({
        version,
        pkgDir: join(proj, "node_modules", "wrapper", "node_modules", "obsidian-tc"),
        userAgent: "npm/10.8.0 node/v24.1.0",
        exists: () => true,
      }),
    ).toBeUndefined();
  });

  it("a Windows global install is planned from the npm root with the Windows separators", () => {
    const root = "C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\node_modules";
    expect(
      planEmbedderInstall({
        version,
        pkgDir: `${root}\\obsidian-tc`,
        globalRoot: root,
        userAgent: "npm/10.8.0 node/v24.1.0",
        exists: () => false,
      }),
    ).toEqual(globalPlan);
  });

  it("a Windows project install runs in that project, not the process cwd", () => {
    const winProj = "C:\\Users\\Jane Doe\\proj";
    expect(
      planEmbedderInstall({
        version,
        pkgDir: `${winProj}\\node_modules\\obsidian-tc`,
        userAgent: "npm/10.8.0 node/v24.1.0",
        exists: (p) => p === `${winProj}\\package.json`,
      }),
    ).toEqual({
      manager: "npm",
      cwd: winProj,
      global: false,
      argv: ["install", "--save-exact", SPEC],
    });
  });

  it("embedderInstallCommand prints the exact command the plan runs", () => {
    expect(embedderInstallCommand(npmPlan)).toBe(`npm install --save-exact ${SPEC}`);
    expect(embedderInstallCommand(bunPlan)).toBe(`bun add --exact ${SPEC}`);
    expect(embedderInstallCommand(globalPlan)).toBe(`npm install --global ${SPEC}`);
  });
});

describe("invocationFor and runEmbedderInstall — how the plan is spawned", () => {
  const npmCli = join("/usr", "lib", "node_modules", "npm", "bin", "npm-cli.js");

  it("npm under npm runs its own JS entry through process.execPath, with no shell", () => {
    expect(
      invocationFor("npm", ["install", "--global", SPEC], {
        env: { npm_execpath: npmCli },
        platform: "win32",
      }),
    ).toEqual({
      command: process.execPath,
      args: [npmCli, "install", "--global", SPEC],
      shell: false,
    });
  });

  it("on Windows without npm's entry, one pre-joined command string and no args-with-shell", () => {
    const inv = invocationFor("npm", ["install", "--global", SPEC], {
      env: {},
      platform: "win32",
    });
    expect(inv).toEqual({ command: `npm install --global ${SPEC}`, args: [], shell: true });
  });

  it("a non-npm manager on POSIX runs directly, without a shell", () => {
    expect(invocationFor("bun", ["add", "--exact", SPEC], { env: {}, platform: "linux" })).toEqual({
      command: "bun",
      args: ["add", "--exact", SPEC],
      shell: false,
    });
  });

  it("ignores an npm_execpath that is another manager's entry", () => {
    expect(
      invocationFor("npm", ["install", SPEC], {
        env: { npm_execpath: "/x/pnpm/bin/pnpm.cjs" },
        platform: "linux",
      }),
    ).toEqual({ command: "npm", args: ["install", SPEC], shell: false });
  });

  it("runs a local plan in its project with the timeout, and a global plan from the home directory", () => {
    const spawn = vi.fn<SpawnFn>(() => ({ status: 0, signal: null, error: undefined }));
    expect(runEmbedderInstall(npmPlan, { spawn, env: {}, platform: "linux" })).toEqual({
      ok: true,
    });
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({
      cwd: "/home/u/proj",
      timeout: INSTALL_TIMEOUT_MS,
      stdio: "inherit",
    });

    spawn.mockClear();
    runEmbedderInstall(globalPlan, { spawn, env: {}, platform: "linux" });
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ cwd: homedir() });
  });

  it("reports a signal-killed install by its signal, not as 'status null'", () => {
    const spawn = vi.fn<SpawnFn>(() => ({
      status: null,
      signal: "SIGKILL" as const,
      error: undefined,
    }));
    const r = runEmbedderInstall(npmPlan, { spawn, env: {}, platform: "linux" });
    expect(r).toEqual({ ok: false, error: "npm was killed by SIGKILL" });
  });

  it("reports a timed-out install as the spawn error, and a non-zero exit by its status", () => {
    const timedOut = vi.fn<SpawnFn>(() => ({
      status: null,
      signal: "SIGTERM" as const,
      error: new Error("spawnSync npm ETIMEDOUT"),
    }));
    expect(runEmbedderInstall(npmPlan, { spawn: timedOut, env: {}, platform: "linux" })).toEqual({
      ok: false,
      error: "spawnSync npm ETIMEDOUT",
    });
    const failed = vi.fn<SpawnFn>(() => ({ status: 1, signal: null, error: undefined }));
    expect(runEmbedderInstall(npmPlan, { spawn: failed, env: {}, platform: "linux" })).toEqual({
      ok: false,
      error: "npm exited with status 1",
    });
  });
});

describe("isYesAnswer — only an explicit yes (or Enter) installs", () => {
  it("accepts y, yes and an empty answer", () => {
    for (const a of ["", " ", "y", "Y", "yes", " YES "]) expect(isYesAnswer(a)).toBe(true);
  });
  it("refuses everything else, including words that merely start with n or y", () => {
    for (const a of ["n", "no", "nope", "yep", "x", "yesterday"])
      expect(isYesAnswer(a)).toBe(false);
  });
});

describe("ownPackageDir — obsidian-tc's own package directory", () => {
  it("walks up from a nested compiled location to the package named obsidian-tc", () => {
    const root = makeTempDir("otc-own-pkg-");
    tmpDirs.push(root);
    mkdirSync(join(root, "dist", "cli"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "obsidian-tc" }));
    expect(ownPackageDir(pathToFileURL(join(root, "dist", "cli", "x.js")).href)).toBe(root);
  });

  it("skips a package.json that is not obsidian-tc's", () => {
    const root = makeTempDir("otc-own-pkg-other-");
    tmpDirs.push(root);
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "something-else" }));
    expect(ownPackageDir(pathToFileURL(join(root, "dist", "x.js")).href)).not.toBe(root);
  });
});

describe("obsidian-tc setup offers to install the local embedder", () => {
  it("accepted: installs once with the planned argv, and the verified install is trusted without a second in-process probe", async () => {
    const { configPath, vaultPath } = sandbox();
    vi.mocked(probeLocalEmbedderResolution).mockResolvedValue(missing);
    const ask = vi.fn(async (_question: string) => true);
    const run = vi.fn((_plan: EmbedderInstallPlan) => ({ ok: true as const }));
    const verify = vi.fn(() => true);

    await run_setup(cmd(vaultPath, configPath), {
      interactive: true,
      ask,
      plan: () => npmPlan,
      run,
      verify,
    });

    expect(ask).toHaveBeenCalledTimes(1);
    expect(String(ask.mock.calls[0]?.[0])).toContain(`Install ${SPEC} now by running`);
    expect(String(ask.mock.calls[0]?.[0])).toContain("npm install --save-exact");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(npmPlan);
    expect(verify).toHaveBeenCalledTimes(1);
    // Bun caches a failed dynamic import in-process: the child-process verification is the truth.
    expect(vi.mocked(probeLocalEmbedderResolution)).toHaveBeenCalledTimes(1);
    expect(out()).toContain("provider=local");
    expect(out()).not.toContain("NOTICE");
  });

  it("accepted under bun: the bun add argv is what runs", async () => {
    const { configPath, vaultPath } = sandbox();
    vi.mocked(probeLocalEmbedderResolution).mockResolvedValue(missing);
    const run = vi.fn((_plan: EmbedderInstallPlan) => ({ ok: true as const }));

    await run_setup(cmd(vaultPath, configPath), {
      interactive: true,
      ask: async () => true,
      plan: () => bunPlan,
      run,
      verify: () => true,
    });

    expect(run).toHaveBeenCalledWith(bunPlan);
    expect(run.mock.calls[0]?.[0].argv).toEqual(["add", "--exact", SPEC]);
  });

  it("installed but not loadable by a fresh process: says so, and does not claim it is working", async () => {
    const { configPath, vaultPath } = sandbox();
    vi.mocked(probeLocalEmbedderResolution).mockResolvedValue(missing);

    await run_setup(cmd(vaultPath, configPath), {
      interactive: true,
      ask: async () => true,
      plan: () => npmPlan,
      run: () => ({ ok: true as const }),
      verify: () => false,
    });

    expect(err()).toContain("cannot load it yet");
    expect(out()).toContain("NOTICE");
  });

  it("declined: no install, the decline line names the planned command, and the notice follows", async () => {
    const { configPath, vaultPath } = sandbox();
    vi.mocked(probeLocalEmbedderResolution).mockResolvedValue(missing);
    const run = vi.fn((_plan: EmbedderInstallPlan) => ({ ok: true as const }));

    await run_setup(cmd(vaultPath, configPath), {
      interactive: true,
      ask: async () => false,
      plan: () => globalPlan,
      run,
    });

    expect(run).not.toHaveBeenCalled();
    expect(vi.mocked(probeLocalEmbedderResolution)).toHaveBeenCalledTimes(1);
    // The decline line is the one that names the PLANNED command (global here), not the notice's.
    expect(out()).toMatch(
      new RegExp(`not installed\\. Install it later with: npm install --global ${SPEC}\\n`),
    );
    expect(out()).toContain("NOTICE");
    expect(out()).toContain("could not be confirmed working");
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
    expect(out()).toContain(`obsidian-tc setup: ${EMBEDDER_PACKAGE} is not installed.`);
    expect(out()).toContain(`Install it with: npm install --save-exact ${SPEC}`);
  });

  it.each([
    ["--yes", { yes: true, dryRun: false }],
    ["--dry-run", { yes: false, dryRun: true }],
  ])("with %s and no TTY, the real wiring never asks or installs", async (_flag, flags) => {
    const { configPath, vaultPath } = sandbox();
    vi.mocked(probeLocalEmbedderResolution).mockResolvedValue(missing);
    const run = vi.fn((_plan: EmbedderInstallPlan) => ({ ok: true as const }));
    const prior = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
    try {
      // interactive is NOT injected: the default (TTY, no --yes, no --dry-run) must decide.
      await run_setup({ ...cmd(vaultPath, configPath), ...flags }, { plan: () => npmPlan, run });
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: prior, configurable: true });
    }
    expect(run).not.toHaveBeenCalled();
    expect(out()).toContain("Install it with: npm install --save-exact");
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
    expect(out()).toContain(`Install it with: npm install --save-exact ${SPEC}`);
  });

  it("an existing invalid config refuses before any offer: no prompt and no install", async () => {
    const { configPath, vaultPath } = sandbox();
    writeFileSync(
      configPath,
      '{ "vaults": [ { "id": 7 } ], "embeddings": { "provider": "nope" } }',
    );
    vi.mocked(probeLocalEmbedderResolution).mockResolvedValue(missing);
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
    expect(err()).toContain("refusing to touch");
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
