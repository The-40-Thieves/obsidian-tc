// The reranker-local staging helper turns a hung or failed `bun` step into an Error. On 2026-10-28
// five full-suite matrix runs died with only vitest's generic "Hook timed out in 180000ms", because
// the install step named nothing and its stderr was dropped. These cases pin the message shape:
// the command, the cwd, the timeout and the tail of stderr (bun prints the package it is fetching
// last, so the tail is what names the slow step).
import { describe, expect, it } from "vitest";
import { describeStepFailure } from "./reranker-local-stage";

const CWD = "/work/packages/reranker-local";

describe("describeStepFailure", () => {
  it("names the command, cwd, timeout and stderr tail when a step is killed", () => {
    const message = describeStepFailure(
      "bun",
      ["install", "--frozen-lockfile"],
      CWD,
      { timedOut: true, ms: 180_000 },
      "resolving @huggingface/transformers\n",
    );

    expect(message).toContain("bun install --frozen-lockfile");
    expect(message).toContain(CWD);
    expect(message).toContain("timed out after 180000ms and was killed");
    expect(message).toContain("resolving @huggingface/transformers");
  });

  it("keeps only the last 2000 characters of a long stderr", () => {
    const stderr = "H".repeat(1_000) + "M".repeat(1_000) + "T".repeat(1_000);

    const message = describeStepFailure(
      "bun",
      ["run", "build"],
      CWD,
      { code: null, signal: "SIGKILL" },
      stderr,
    );

    expect(message).toContain("M".repeat(1_000) + "T".repeat(1_000));
    expect(message).not.toContain("H");
  });

  it("names the exit code, signal and stderr when a step fails", () => {
    const message = describeStepFailure(
      "bun",
      ["run", "build"],
      CWD,
      { code: 2, signal: null },
      "error TS2307: Cannot find module",
    );

    expect(message).toContain(`bun run build in ${CWD} exited 2`);
    expect(message).toContain("error TS2307: Cannot find module");
  });
});
