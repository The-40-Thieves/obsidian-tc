// THE-518 — config provenance. The value of this feature is entirely in the ATTRIBUTION being
// right: a diagnostic that says "default" for an env-supplied value is worse than no diagnostic,
// because it sends the reader to edit a file that is not the cause.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type ConfigExplanation,
  ENV_OVERLAYS,
  explainConfig,
  formatConfigError,
} from "../src/config/explain";

const VAULTS = [{ id: "main", path: "/tmp/vault" }];
// jwtSecret has a 32-character minimum in the schema — a short fixture fails validation before
// provenance is ever computed, which is the schema doing its job.
const SECRET_A = "a".repeat(40);
const SECRET_B = "b".repeat(40);
const base = (over: Record<string, unknown> = {}) => ({ vaults: VAULTS, ...over });
const find = (e: ConfigExplanation, path: string) => e.entries.find((x) => x.path === path);

describe("THE-518 config provenance", () => {
  it("attributes a value the file set to the file", () => {
    const e = explainConfig(base({ retrieval: { rrfK: 60 } }), { env: {} });
    expect(find(e, "retrieval.rrfK")).toMatchObject({ value: 60, source: "file" });
  });

  it("attributes an untouched value to the schema default", () => {
    const e = explainConfig(base(), { env: {} });
    // Someone asking "why is rrfK 10 when my config never mentions it" gets an answer.
    expect(find(e, "retrieval.rrfK")).toMatchObject({ value: 10, source: "default" });
  });

  it("attributes an env-supplied value to the env, naming the variable", () => {
    const e = explainConfig(base(), { env: { OBSIDIAN_TC_JWT_SECRET: SECRET_A } });
    const entry = find(e, "auth.jwtSecret");
    expect(entry?.source).toBe("env");
    expect(entry?.detail).toBe("OBSIDIAN_TC_JWT_SECRET");
  });

  it("reports the SOURCE of a secret without printing the secret", () => {
    // The whole point of tracing rather than dumping: this output is what a user pastes into an
    // issue, and "it came from OBSIDIAN_TC_JWT_SECRET" is the useful half.
    const e = explainConfig(base(), { env: { OBSIDIAN_TC_JWT_SECRET: SECRET_A } });
    const entry = find(e, "auth.jwtSecret");
    expect(entry?.value).toBe("<redacted>");
    expect(entry?.redacted).toBe(true);
    expect(JSON.stringify(e)).not.toContain(SECRET_A);
  });

  it("redacts a secret that came from the FILE too, not just from the env", () => {
    const e = explainConfig(base({ auth: { jwtSecret: SECRET_A } }), { env: {} });
    const entry = find(e, "auth.jwtSecret");
    expect(entry?.source).toBe("file");
    expect(entry?.value).toBe("<redacted>");
    expect(JSON.stringify(e)).not.toContain(SECRET_A);
  });

  it("puts env ABOVE file — the precedence load.ts actually implements", () => {
    const e = explainConfig(base({ auth: { jwtSecret: SECRET_A } }), {
      env: { OBSIDIAN_TC_JWT_SECRET: SECRET_B },
    });
    // finalizeConfig spreads the env value over the file's, so the env wins and the report must
    // say so — otherwise a user edits the file and nothing changes.
    expect(find(e, "auth.jwtSecret")?.source).toBe("env");
    expect(find(e, "auth.jwtSecret")?.detail).toBe("OBSIDIAN_TC_JWT_SECRET");
  });

  it("marks a relative cacheDir as derived, not as the file's value", () => {
    const e = explainConfig(base({ cacheDir: ".obsidian-tc" }), { env: {} });
    const entry = find(e, "cacheDir");
    // The resolved value is an absolute home-anchored path that appears nowhere in the file, so
    // calling it "file" would be a lie about a value the user cannot find by reading their config.
    expect(entry?.source).toBe("derived");
    expect(entry?.detail).toMatch(/anchored/);
    expect(String(entry?.value)).not.toBe(".obsidian-tc");
  });

  it("leaves an absolute cacheDir attributed to the file", () => {
    const e = explainConfig(base({ cacheDir: "/var/lib/obsidian-tc" }), { env: {} });
    expect(find(e, "cacheDir")).toMatchObject({
      value: "/var/lib/obsidian-tc",
      source: "file",
    });
  });

  it("counts every entry into exactly one bucket", () => {
    const e = explainConfig(base({ retrieval: { rrfK: 60 } }), { env: {} });
    const total = Object.values(e.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(e.entries.length);
    expect(e.entries.length).toBeGreaterThan(20); // a collapsed walk would pass everything else
  });

  it("returns entries sorted by path so two runs diff cleanly", () => {
    const e = explainConfig(base(), { env: {} });
    const paths = e.entries.map((x) => x.path);
    expect([...paths].sort((a, b) => a.localeCompare(b))).toEqual(paths);
  });

  it("treats an array as ONE decision, not N", () => {
    // `vaults` is a single choice; exploding it into vaults.0.id would bury the report.
    const e = explainConfig(base(), { env: {} });
    expect(find(e, "vaults")?.source).toBe("file");
    expect(e.entries.some((x) => x.path.startsWith("vaults."))).toBe(false);
  });
});

describe("THE-518 ENV_OVERLAYS stays in step with load.ts", () => {
  it("lists every environment variable the loader actually reads", () => {
    // The overlay in load.ts is hand-written, so this list is a hand-kept copy — the drift class
    // this repo keeps finding. Deriving the expectation from the SOURCE means an overlay added
    // there without a line here fails the build instead of silently reporting "default".
    const src = readFileSync(
      fileURLToPath(new URL("../src/config/load.ts", import.meta.url)),
      "utf8",
    );
    const read = [...src.matchAll(/env\.([A-Z0-9_]+)/g)].map((m) => m[1] as string);
    expect(read.length).toBeGreaterThan(0); // an empty scan must not pass vacuously
    const declared = new Set(ENV_OVERLAYS.map(([, v]) => v));
    expect([...new Set(read)].filter((v) => !declared.has(v))).toEqual([]);
  });
});

describe("THE-518 invalid config fails fast with a readable diagnostic", () => {
  it("renders one line per problem instead of a zod dump", () => {
    let err: unknown;
    try {
      explainConfig({ vaults: "not-an-array" }, { env: {} });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    const msg = formatConfigError(err);
    expect(msg).toMatch(/^config is invalid \(\d+ problem/);
    expect(msg).toContain("vaults");
    // The point is that the KEY is visible; a raw zod dump buries it in JSON.
    expect(msg.split("\n").length).toBeGreaterThan(1);
  });

  it("falls back to the plain message for a non-zod error", () => {
    expect(formatConfigError(new Error("boom"))).toBe("boom");
  });
});

describe("THE-518 `config explain` CLI parsing", () => {
  it("parses the subcommand, the path, --json and --source", async () => {
    const { parseCliArgs } = await import("../src/cli/args");
    expect(parseCliArgs(["config", "explain", "/tmp/c.json"])).toMatchObject({
      kind: "config-explain",
      configPath: "/tmp/c.json",
      json: false,
    });
    expect(parseCliArgs(["config", "explain", "/tmp/c.json", "--json"])).toMatchObject({
      kind: "config-explain",
      configPath: "/tmp/c.json",
      json: true,
    });
    expect(parseCliArgs(["config", "explain", "/tmp/c.json", "--source", "env"])).toMatchObject({
      kind: "config-explain",
      source: "env",
    });
  });

  it("rejects an unknown --source rather than silently returning everything", () => {
    // Silently ignoring a typo'd filter would show the FULL config to someone who asked for one
    // slice of it, and they would read it as "these all came from env".
    return import("../src/cli/args").then(({ parseCliArgs }) => {
      expect(parseCliArgs(["config", "explain", "/tmp/c.json", "--source", "bogus"])).toMatchObject(
        {
          kind: "error",
        },
      );
    });
  });

  it("does not mistake --source's value for the config path", async () => {
    const { parseCliArgs } = await import("../src/cli/args");
    const cmd = parseCliArgs(["config", "explain", "--source", "file"]);
    expect(cmd).toMatchObject({ kind: "config-explain", source: "file" });
    expect((cmd as { configPath?: string }).configPath).toBeUndefined();
  });
});
