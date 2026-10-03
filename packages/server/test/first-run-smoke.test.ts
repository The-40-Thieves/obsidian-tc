import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildReport,
  classifySemantic,
  expandMcpbVars,
  failureLine,
  nodeSatisfies,
  parseBanner,
  parseExpectedFailures,
  renderMatrix,
  toolPayload,
} from "../scripts/lib/first-run-smoke-lib.mjs";
import { runBunSync } from "./spawn-cli";
import { makeTempDir, rmTemp } from "./tmp";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");

/** A callTool result carrying `payload` as the single JSON text block, as the facade returns it. */
const asResult = (payload: unknown, isError = false) => ({
  content: [
    { type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) },
  ],
  ...(isError ? { isError: true } : {}),
});

describe("parseBanner", () => {
  it("reads the real boot line, with and without the native addon", () => {
    expect(
      parseBanner("obsidian-tc 1.32.0 ready on stdio (vault main; native=on vec=on)\n"),
    ).toEqual({ version: "1.32.0", vault: "main", native: "on", vec: "on" });
    expect(
      parseBanner(
        "noise\nobsidian-tc 1.32.0 ready on stdio (vault main; native=js-fallback vec=off)",
      ),
    ).toEqual({ version: "1.32.0", vault: "main", native: "js-fallback", vec: "off" });
  });
  it("returns null when the server never reached stdio-ready", () => {
    expect(parseBanner("Error: Cannot find module 'sqlite-vec'")).toBeNull();
    expect(parseBanner("obsidian-tc 1.32.0 ready (http-only; stdio disabled)")).toBeNull();
  });
});

describe("nodeSatisfies", () => {
  it("compares against a >= floor", () => {
    expect(nodeSatisfies("v24.0.0", ">=24.0.0")).toBe(true);
    expect(nodeSatisfies("v26.10.0", ">=24")).toBe(true);
    expect(nodeSatisfies("v22.12.0", ">=24.0.0")).toBe(false);
    expect(nodeSatisfies("v24.0.0", ">=24.0.1")).toBe(false);
    expect(nodeSatisfies("24.3.0", ">=24.2")).toBe(true);
  });
  it("refuses a range form it does not understand rather than guessing", () => {
    expect(() => nodeSatisfies("v24.0.0", "^24")).toThrow(/unsupported node range/);
    expect(() => nodeSatisfies("nope", ">=24")).toThrow(/unparseable/);
  });
});

describe("the real MCPB manifest", () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "mcpb", "manifest.json"), "utf8")) as {
    server: { mcp_config: { command: string; args: string[]; env: Record<string, string> } };
    compatibility: { runtimes: { node: string } };
  };

  it("expands to a node invocation of the bundled entry with the pasted vault folder", () => {
    const cfg = manifest.server.mcp_config;
    const vars = { dirname: "/ext", userConfig: { config_path: "/my/vault", default_vault: "" } };
    expect(cfg.command).toBe("node");
    expect(cfg.args.map((a) => expandMcpbVars(a, vars))).toEqual([
      "/ext/packages/server/dist/cli.js",
      "/my/vault",
    ]);
    expect(expandMcpbVars(cfg.env.OBSIDIAN_TC_DEFAULT_VAULT ?? "", vars)).toBe("");
  });

  it("declares a node floor in the only form the harness can compare", () => {
    expect(() => nodeSatisfies("v24.0.0", manifest.compatibility.runtimes.node)).not.toThrow();
  });

  it("uses the same mcpb CLI pin as bundle-mcpb.ts", () => {
    const pin = /const MCPB = "([^"]+)"/.exec(
      readFileSync(join(REPO_ROOT, "scripts", "bundle-mcpb.ts"), "utf8"),
    )?.[1];
    expect(pin).toBeTruthy();
    expect(readFileSync(join(PACKAGE_ROOT, "scripts", "first-run-smoke.ts"), "utf8")).toContain(
      `const MCPB_CLI = "${pin}";`,
    );
  });

  it("rejects a placeholder it does not know", () => {
    expect(() =>
      expandMcpbVars(["$", "{nope}"].join(""), { dirname: "/", userConfig: {} }),
    ).toThrow(/unsupported/);
  });
});

describe("failureLine / toolPayload", () => {
  it("picks the last error-looking line, else the last line, else the fallback", () => {
    expect(failureLine("booting\nError: Cannot find module 'x'\ntrailing note\n")).toBe(
      "Error: Cannot find module 'x'",
    );
    expect(failureLine("one\ntwo\n")).toBe("two");
    expect(failureLine("", "nothing")).toBe("nothing");
    expect(failureLine("x".repeat(400)).length).toBeLessThanOrEqual(300);
  });
  it("unwraps structuredContent and text JSON, and returns undefined for prose", () => {
    expect(toolPayload({ structuredContent: { items: [1] } })).toEqual({ items: [1] });
    expect(toolPayload(asResult({ result: { items: [2] } }))).toEqual({ items: [2] });
    expect(toolPayload(asResult("Error: boom"))).toBeUndefined();
  });
});

describe("classifySemantic: which retriever answered", () => {
  const dense = { path: "sourdough.md", score: 0.9, embedding_model: "local:nomic" };
  it("semantic: dense stamp on every hit and the target note first", () => {
    const r = classifySemantic(asResult({ mode_used: "semantic", items: [dense] }), "sourdough.md");
    expect(r.kind).toBe("semantic");
    expect(r.model).toBe("local:nomic");
  });
  it("error: an isError result is not an answer", () => {
    const r = classifySemantic(
      asResult("Error [internal]: internal error (retryable)", true),
      "sourdough.md",
    );
    expect(r).toEqual({ kind: "error", detail: "Error [internal]: internal error (retryable)" });
  });
  it("empty: no hits", () => {
    expect(
      classifySemantic(asResult({ mode_used: "semantic", items: [] }), "sourdough.md").kind,
    ).toBe("empty");
  });
  it("not-dense: hits without the embedding stamp (a lexical fallback) never count as semantic", () => {
    const lexical = classifySemantic(
      asResult({ mode_used: "text", items: [{ path: "sourdough.md", score: 1 }] }),
      "sourdough.md",
    );
    expect(lexical.kind).toBe("not-dense");
    const mixed = classifySemantic(
      asResult({ mode_used: "semantic", items: [dense, { path: "b.md", score: 0.1 }] }),
      "sourdough.md",
    );
    expect(mixed.kind).toBe("not-dense");
  });
  it("wrong-top: dense hits that rank the wrong note first", () => {
    const r = classifySemantic(
      asResult({ mode_used: "semantic", items: [{ ...dense, path: "budget.md" }] }),
      "sourdough.md",
    );
    expect(r.kind).toBe("wrong-top");
  });
});

describe("report + 3x3 table", () => {
  const pass = buildReport({
    path: "npm",
    platform: "linux",
    arch: "x64",
    node: "v24",
    stages: [{ stage: "boot", status: "pass", detail: "ok" }],
  });
  const fail = buildReport({
    path: "mcpb",
    platform: "linux",
    arch: "x64",
    node: "v24",
    stages: [
      { stage: "boot", status: "pass", detail: "ok" },
      { stage: "vec", status: "fail", detail: "vec=off | pipe" },
      { stage: "reconcile", status: "fail", detail: "later" },
    ],
  });
  it("records the FIRST failed stage as the failure line", () => {
    expect(pass).toMatchObject({ result: "pass", firstFailure: null });
    expect(fail).toMatchObject({ result: "fail", firstFailure: "vec: vec=off | pipe" });
  });
  it("renders pass / expected fail / unexpected fail / XPASS / missing, escaping pipes", () => {
    const table = renderMatrix({
      paths: ["npm", "mcpb"],
      oses: ["ubuntu-latest", "macos-latest"],
      reports: new Map([
        ["npm/ubuntu-latest", pass],
        ["npm/macos-latest", fail],
        ["mcpb/ubuntu-latest", pass],
      ]),
      expected: parseExpectedFailures("mcpb/ubuntu-latest  npm/macos-latest"),
    });
    expect(table).toBe(
      [
        "| path | ubuntu-latest | macos-latest |",
        "|---|---|---|",
        "| npm | PASS | FAIL (expected): vec: vec=off \\| pipe |",
        "| mcpb | PASS (XPASS: drop from EXPECTED_FAILURES) | NO REPORT |",
      ].join("\n"),
    );
  });
});

describe("first-run-smoke.ts against the stub server (watched red AND green)", () => {
  function runHarness(mode: string) {
    const dir = makeTempDir("first-run-smoke-");
    try {
      const reportFile = join(dir, "report.json");
      const r = runBunSync(
        [
          "scripts/first-run-smoke.ts",
          "--path",
          "cli",
          "--artifact",
          "test/fixtures/first-run-stub-server.mjs",
          "--env",
          `STUB_MODE=${mode}`,
          "--reconcile-timeout-ms",
          "5000",
          "--boot-timeout-ms",
          "15000",
          "--report",
          reportFile,
        ],
        { cwd: PACKAGE_ROOT, timeoutMs: 60_000 },
      );
      const report = JSON.parse(readFileSync(reportFile, "utf8")) as ReturnType<typeof buildReport>;
      return { r, report };
    } finally {
      rmTemp(dir);
    }
  }
  const status = (report: ReturnType<typeof buildReport>, stage: string) =>
    report.stages.find((s: { stage: string }) => s.stage === stage);

  it("good: every stage passes, exit 0, and the banner's native/vec status is reported", () => {
    const { r, report } = runHarness("good");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("FIRST-RUN cli");
    expect(report.result).toBe("pass");
    expect(status(report, "banner")?.detail).toContain("native=on vec=on");
    expect(status(report, "search_semantic")?.detail).toContain("semantic: top hit sourdough.md");
  });

  it("no-embedder: exits 1, vec=off and the degraded reconcile reason are the failure lines", () => {
    const { r, report } = runHarness("no-embedder");
    expect(r.code, r.stderr).toBe(1);
    expect(report.firstFailure).toMatch(/^vec: vec=off/);
    expect(status(report, "banner")?.detail).toContain("native=js-fallback vec=off");
    expect(status(report, "reconcile")?.detail).toContain(
      "could not resolve the optional embedder package",
    );
    expect(status(report, "search_semantic")).toMatchObject({ status: "fail" });
    expect(status(report, "search_semantic")?.detail).toMatch(/^error: .*embedding_provider_error/);
  });

  it("lexical: a lexical answer to search_semantic fails the stage instead of passing as semantic", () => {
    const { r, report } = runHarness("lexical");
    expect(r.code, r.stderr).toBe(1);
    expect(status(report, "search_semantic")).toMatchObject({ status: "fail" });
    expect(status(report, "search_semantic")?.detail).toMatch(/^not-dense: mode_used=text/);
  });

  it("crash: a server that dies at load fails boot with its own error line, later stages skip", () => {
    const { r, report } = runHarness("crash");
    expect(r.code, r.stderr).toBe(1);
    expect(report.firstFailure).toMatch(/^boot: .*Cannot find module 'sqlite-vec'/);
    expect(status(report, "reconcile")).toMatchObject({ status: "skip" });
    expect(status(report, "search_semantic")).toMatchObject({ status: "skip" });
  });
});
