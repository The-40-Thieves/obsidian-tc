// PR A of the `obsidian-tc setup` split (GH #995 follow-up): argv parsing for
// `setup [--yes] [--dry-run] [--force] [--config <path>] [--vault <path>]`. No positional config
// path — unlike every other command here, `setup` takes only named flags, since a bare positional
// would be ambiguous between "the config to write" and "the vault to detect from".
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli/args";

describe("parseCliArgs setup", () => {
  it("bare `setup` -> every flag false/undefined", () => {
    expect(parseCliArgs(["setup"])).toEqual({
      kind: "setup",
      yes: false,
      dryRun: false,
      force: false,
    });
  });

  it("--yes, --dry-run, --force are independent booleans", () => {
    const c = parseCliArgs(["setup", "--yes", "--dry-run", "--force"]);
    expect(c).toMatchObject({ kind: "setup", yes: true, dryRun: true, force: true });
  });

  it("--config <path> is captured", () => {
    const c = parseCliArgs(["setup", "--config", "/tmp/o.json"]);
    if (c.kind !== "setup") throw new Error("expected setup");
    expect(c.configPath).toBe("/tmp/o.json");
  });

  it("--vault <path> is captured", () => {
    const c = parseCliArgs(["setup", "--vault", "/home/me/vault"]);
    if (c.kind !== "setup") throw new Error("expected setup");
    expect(c.vaultPath).toBe("/home/me/vault");
  });

  it("--config and --vault together, order-independent", () => {
    const c = parseCliArgs(["setup", "--vault", "/v", "--yes", "--config", "/c.json"]);
    if (c.kind !== "setup") throw new Error("expected setup");
    expect(c.vaultPath).toBe("/v");
    expect(c.configPath).toBe("/c.json");
    expect(c.yes).toBe(true);
  });

  it("--config with no value is a usage error, not a silently eaten flag", () => {
    const c = parseCliArgs(["setup", "--config"]);
    expect(c.kind).toBe("error");
  });

  it("--config=<path> form is accepted (flagValue's generic --flag=value support)", () => {
    const c = parseCliArgs(["setup", "--config=/c.json"]);
    if (c.kind !== "setup") throw new Error("expected setup");
    expect(c.configPath).toBe("/c.json");
  });

  // Fix round (Codex review 1001-verify), finding 4 (HIGH): a misspelled safety flag must be a
  // usage error, never silently parsed as "flag absent" and fall through to a real write.
  it("--dryrun (typo for --dry-run) is a usage error, not a silently ignored flag", () => {
    const c = parseCliArgs(["setup", "--yes", "--dryrun"]);
    expect(c.kind).toBe("error");
  });

  it("a stray positional argument is a usage error", () => {
    const c = parseCliArgs(["setup", "/tmp/intended.json", "--yes"]);
    expect(c.kind).toBe("error");
  });

  it("a stray positional does NOT get silently read as the config path", () => {
    // Guard against the exact failure scenario the review named: `setup /tmp/intended.json --yes`
    // must never write to the DEFAULT path while ignoring the positional.
    const c = parseCliArgs(["setup", "/tmp/intended.json", "--yes"]);
    expect(c.kind).toBe("error");
    if (c.kind === "setup") throw new Error("must not parse as a valid setup command");
  });

  // Fix round 2 (Codex review 1001-verify-r2), finding 1 (HIGH): `--dry-run=true` used to be
  // stripped as a KNOWN flag (the same `=value` stripping legitimately applied to --config/--vault)
  // and then silently read as false by `rest.includes("--dry-run")` — a safety flag that LOOKS
  // recognized and still lets a real write through, the same incident class the `--dryrun` typo fix
  // above already closed. None of this CLI's boolean flags support an `=` form anywhere else (see
  // e.g. parse-consolidate.ts's own `--dry-run`), so the `=` form must be a usage error, exactly
  // like a typo — never a silently-ignored-but-accepted flag.
  it("--dry-run=true is a usage error, not a silently-false dry-run flag", () => {
    const c = parseCliArgs(["setup", "--yes", "--dry-run=true"]);
    expect(c.kind).toBe("error");
    if (c.kind === "setup") throw new Error("must not parse as a valid setup command");
  });

  it("--yes=true and --force=true are usage errors for the same reason", () => {
    expect(parseCliArgs(["setup", "--yes=true"]).kind).toBe("error");
    expect(parseCliArgs(["setup", "--yes", "--force=true"]).kind).toBe("error");
  });

  // Finding 6 (MEDIUM): `--vault=` / `--config=` with an EMPTY value must never be read as "no
  // value given" (undefined, falling back to detection) NOR silently resolve to cwd downstream —
  // it must be a usage error at parse time, before any I/O.
  it("--vault= (empty value) is a usage error, not a silent cwd fallback", () => {
    const c = parseCliArgs(["setup", "--vault=", "--yes"]);
    expect(c.kind).toBe("error");
  });

  it("--config= (empty value) is a usage error", () => {
    const c = parseCliArgs(["setup", "--config=", "--yes"]);
    expect(c.kind).toBe("error");
  });
});
