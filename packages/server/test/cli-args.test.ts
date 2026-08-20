import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configFromVaultPath,
  parseCliArgs,
  redactConfig,
  resolveServeConfig,
  resolveServeConfigWithProvenance,
} from "../src/cli/args";
import { rmTemp } from "./tmp";

// THE-685: every temp dir this suite creates is tracked and removed. These calls previously had NO
// teardown at all - a leak on every OS, invisible on POSIX (where /tmp is reaped) and unbounded on
// Windows (where %TEMP% is not): 7,655 stale dirs measured on one box, this suite’s prefixes among
// the largest contributors. Distinct from the teardown-that-FAILS class #627 fixes; that sweep is
// derived from suites that already had teardown, so by construction it could not reach this one.
const tmpDirs: string[] = [];
const tmpDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmTemp(d);
    } catch {
      // Best-effort by design: a leaked temp dir is cheaper than failing a suite in TEARDOWN with
      // every assertion passing - the exact shape #627 exists to remove.
    }
  }
});

describe("parseCliArgs doctor (THE-521)", () => {
  it("bare doctor -> doctor with json:false AND probe:false (offline by default)", () => {
    // THE-688 fix 2: probe:false on a bare invocation is the contract, not an incidental shape.
    // A doctor that reaches the network because someone ran it is a different tool than the one
    // people reach for when something is already broken, so the default must be pinned here.
    expect(parseCliArgs(["doctor"])).toEqual({ kind: "doctor", json: false, probe: false });
  });
  it("doctor --probe opts in, and does not eat the config path", () => {
    const c = parseCliArgs(["doctor", "cfg.json", "--probe"]);
    expect(c.kind).toBe("doctor");
    if (c.kind === "doctor") {
      expect(c.probe).toBe(true);
      expect(c.configPath).toBe("cfg.json");
    }
  });
  it("doctor --json sets json:true", () => {
    const c = parseCliArgs(["doctor", "--json"]);
    expect(c.kind).toBe("doctor");
    if (c.kind === "doctor") expect(c.json).toBe(true);
  });
  it("doctor --token <jwt> captures the token without eating the config path", () => {
    const c = parseCliArgs(["doctor", "cfg.json", "--token", "aaa.bbb.ccc", "--json"]);
    expect(c.kind).toBe("doctor");
    if (c.kind === "doctor") {
      expect(c.token).toBe("aaa.bbb.ccc");
      expect(c.configPath).toBe("cfg.json");
      expect(c.json).toBe(true);
    }
  });
  it("doctor --config <path> is honoured", () => {
    const c = parseCliArgs(["doctor", "--config", "/etc/o.json"]);
    if (c.kind === "doctor") expect(c.configPath).toBe("/etc/o.json");
  });
});

describe("parseCliArgs", () => {
  it("no args -> serve (env fallback handled at resolve time)", () => {
    expect(parseCliArgs([])).toEqual({ kind: "serve" });
  });
  it("version + help flags", () => {
    expect(parseCliArgs(["version"]).kind).toBe("version");
    expect(parseCliArgs(["--version"]).kind).toBe("version");
    expect(parseCliArgs(["-v"]).kind).toBe("version");
    expect(parseCliArgs(["help"]).kind).toBe("help");
    expect(parseCliArgs(["--help"]).kind).toBe("help");
  });
  it("a bare path is a serve target (back-compat)", () => {
    expect(parseCliArgs(["/vault"])).toEqual({ kind: "serve", input: "/vault" });
    expect(parseCliArgs(["./obsidian-tc.config.json"])).toEqual({
      kind: "serve",
      input: "./obsidian-tc.config.json",
    });
  });
  it("serve with positional and --config", () => {
    expect(parseCliArgs(["serve", "/vault"])).toEqual({ kind: "serve", input: "/vault" });
    expect(parseCliArgs(["serve", "--config", "/c.json"])).toEqual({
      kind: "serve",
      input: "/c.json",
    });
  });
  it("config show / validate", () => {
    expect(parseCliArgs(["config", "show"])).toEqual({
      kind: "config-show",
      configPath: undefined,
    });
    expect(parseCliArgs(["config", "show", "/c.json"])).toEqual({
      kind: "config-show",
      configPath: "/c.json",
    });
    expect(parseCliArgs(["config", "validate", "--config", "/c.json"])).toEqual({
      kind: "config-validate",
      configPath: "/c.json",
    });
  });
  it("unknown config subcommand + unknown option are errors", () => {
    expect(parseCliArgs(["config", "bogus"]).kind).toBe("error");
    expect(parseCliArgs(["--bogus"]).kind).toBe("error");
  });
  it("--config with no value is a usage error, not a silent positional/env fallback", () => {
    expect(parseCliArgs(["serve", "--config"])).toEqual({
      kind: "error",
      message: "--config requires a value",
    });
    expect(parseCliArgs(["config", "show", "--config"]).kind).toBe("error");
    // a following token that is itself a flag does not count as the value
    expect(parseCliArgs(["serve", "--config", "--bogus"]).kind).toBe("error");
  });
});

describe("resolveServeConfig / configFromVaultPath", () => {
  it("a directory boots a single vault 'main'", () => {
    const dir = tmpDir("otc-vault-");
    const cfg = resolveServeConfig(dir);
    expect(cfg.vaults).toHaveLength(1);
    expect(cfg.vaults[0]?.id).toBe("main");
    expect(cfg.vaults[0]?.path).toBe(resolve(dir));
    // cacheDir must be absolute + machine-local, not CWD-relative: a GUI launcher (Claude Desktop)
    // spawns MCP servers in a non-writable CWD, so a relative ".obsidian-tc" would EPERM at boot.
    expect(isAbsolute(cfg.cacheDir)).toBe(true);
    expect(cfg.cacheDir).toBe(join(homedir(), ".obsidian-tc"));
  });
  it("a config file is loaded as written", () => {
    const dir = tmpDir("otc-cfg-");
    const file = join(dir, "c.json");
    writeFileSync(file, JSON.stringify({ vaults: [{ id: "v1", path: dir }] }));
    expect(resolveServeConfig(file).vaults[0]?.id).toBe("v1");
  });
  it("cacheDir: explicit absolute is preserved; relative is anchored to home", () => {
    const dir = tmpDir("otc-cache-");
    const abs = join(dir, "cache");
    writeFileSync(
      join(dir, "abs.json"),
      JSON.stringify({ vaults: [{ id: "v", path: dir }], cacheDir: abs }),
    );
    expect(resolveServeConfig(join(dir, "abs.json")).cacheDir).toBe(abs);
    writeFileSync(
      join(dir, "rel.json"),
      JSON.stringify({ vaults: [{ id: "v", path: dir }], cacheDir: "mycache" }),
    );
    expect(resolveServeConfig(join(dir, "rel.json")).cacheDir).toBe(join(homedir(), "mycache"));
  });
  it("a missing target throws a friendly error", () => {
    expect(() => resolveServeConfig(join(tmpdir(), "otc-definitely-missing-xyz"))).toThrow(
      /no such/i,
    );
  });
  it("configFromVaultPath fills schema defaults", () => {
    const dir = tmpDir("otc-def-");
    const cfg = configFromVaultPath(dir);
    expect(cfg.auth.mode).toBe("none");
    expect(cfg.governor.maxResponseBytes).toBeGreaterThan(0);
  });
});

// THE-825: resolveServeConfigWithProvenance is the one substantive implementation --
// resolveServeConfig above is a thin wrapper over it -- so its provenance flag needs its own
// coverage of the same three resolution paths (directory / file-without-key / file-with-key).
describe("resolveServeConfigWithProvenance (THE-825)", () => {
  it("a directory (zero-config) is never explicit -- there is no file to have set it", () => {
    const dir = tmpDir("otc-vault-prov-");
    const { config, planeEnabledExplicit } = resolveServeConfigWithProvenance(dir);
    expect(config.plane.enabled).toBe(false);
    expect(planeEnabledExplicit).toBe(false);
  });

  it("a config file that never mentions plane is not explicit", () => {
    const dir = tmpDir("otc-cfg-prov-absent-");
    const file = join(dir, "c.json");
    writeFileSync(file, JSON.stringify({ vaults: [{ id: "v1", path: dir }] }));
    const { config, planeEnabledExplicit } = resolveServeConfigWithProvenance(file);
    expect(config.plane.enabled).toBe(false);
    expect(planeEnabledExplicit).toBe(false);
  });

  it("a config file that sets plane.enabled: false IS explicit", () => {
    const dir = tmpDir("otc-cfg-prov-false-");
    const file = join(dir, "c.json");
    writeFileSync(
      file,
      JSON.stringify({ vaults: [{ id: "v1", path: dir }], plane: { enabled: false } }),
    );
    const { config, planeEnabledExplicit } = resolveServeConfigWithProvenance(file);
    expect(config.plane.enabled).toBe(false);
    expect(planeEnabledExplicit).toBe(true);
  });

  it("a config file that sets plane.enabled: true IS explicit, and resolves true", () => {
    const dir = tmpDir("otc-cfg-prov-true-");
    const file = join(dir, "c.json");
    writeFileSync(
      file,
      JSON.stringify({ vaults: [{ id: "v1", path: dir }], plane: { enabled: true } }),
    );
    const { config, planeEnabledExplicit } = resolveServeConfigWithProvenance(file);
    expect(config.plane.enabled).toBe(true);
    expect(planeEnabledExplicit).toBe(true);
  });
});

describe("redactConfig", () => {
  it("masks secret-looking keys and leaks no secret value", () => {
    const json = JSON.stringify(
      redactConfig({
        auth: { mode: "jwt", jwtSecret: "supersecret" },
        vaults: [{ id: "main", path: "/v", restApiKey: "abc123" }],
        plur: { endpoint: "http://x", apiKey: "tok-xyz" },
        governor: { maxResponseBytes: 1000000 },
      }),
    );
    expect(json).not.toContain("supersecret");
    expect(json).not.toContain("abc123");
    expect(json).not.toContain("tok-xyz");
    expect(json).toContain('"jwtSecret":"<redacted>"');
    expect(json).toContain('"restApiKey":"<redacted>"');
    expect(json).toContain('"apiKey":"<redacted>"');
    expect(json).toContain('"endpoint":"http://x"');
    expect(json).toContain('"maxResponseBytes":1000000');
  });
  it("masks generic key-suffix fields without over-matching non-key names", () => {
    const json = JSON.stringify(
      redactConfig({ signingKey: "s1", privateKey: "p1", encryptionKey: "e1", keyPath: "/etc/x" }),
    );
    expect(json).not.toContain("s1");
    expect(json).not.toContain("p1");
    expect(json).not.toContain("e1");
    expect(json).toContain('"signingKey":"<redacted>"');
    expect(json).toContain('"privateKey":"<redacted>"');
    expect(json).toContain('"encryptionKey":"<redacted>"');
    // keyPath ends in "path", not "key": it is a file location, not the secret, so it stays.
    expect(json).toContain('"keyPath":"/etc/x"');
  });
});

describe("parseCliArgs — flag validation", () => {
  it("a value-taking flag with no value is a usage error, not a crash", () => {
    expect(parseCliArgs(["serve", "--config"]).kind).toBe("error");
    expect(parseCliArgs(["config", "validate", "--config"]).kind).toBe("error");
  });
});

describe("parseCliArgs — token mint (THE-658)", () => {
  const parse = (args: string[]) => parseCliArgs(["token", "mint", ...args]);

  it("keeps a flag's VALUE from being mistaken for the config path", () => {
    // The trap `doctor --token` documents: an unfiltered positional scan takes the first non-dash
    // token, which for `--sub alice /etc/cfg.json` is "alice". Minting against a config path of
    // "alice" would fail confusingly instead of reading the intended file.
    const cmd = parse(["--sub", "alice", "/etc/cfg.json"]);
    expect(cmd).toMatchObject({ kind: "token-mint", sub: "alice", configPath: "/etc/cfg.json" });
  });

  it("treats a missing --sub as a USAGE error, so it exits 2 like other parse failures", () => {
    expect(parse(["/etc/cfg.json"]).kind).toBe("error");
  });

  it("rejects an unknown token subcommand rather than silently minting", () => {
    expect(parseCliArgs(["token", "frobnicate"]).kind).toBe("error");
    expect(parseCliArgs(["token"]).kind).toBe("error");
  });

  it("rejects a non-numeric --ttl at parse time", () => {
    expect(parse(["--sub", "a", "--ttl", "soon"]).kind).toBe("error");
  });

  it("preserves an EMPTY --scopes, which means no scopes rather than all of them", () => {
    // `flagValue` refuses a value starting with "-", and "" is falsy, so the obvious readings of
    // this flag both lose the distinction. Getting it wrong hands a scrape credential full access.
    expect(parse(["--sub", "a", "--scopes", ""])).toMatchObject({ scopes: "" });
    expect(parse(["--sub", "a"]).kind).toBe("token-mint");
    expect(parse(["--sub", "a"])).not.toHaveProperty("scopes");
  });

  it("carries the remaining flags through", () => {
    expect(
      parse(["--sub", "a", "--aud", "http://x", "--vault", "main", "--ttl", "3600", "--json"]),
    ).toMatchObject({ aud: "http://x", vault: "main", ttl: 3600, json: true });
  });
});

describe("parseCliArgs — elicit (THE-826)", () => {
  const parse = (args: string[]) => parseCliArgs(["elicit", ...args]);

  it("keeps a flag's VALUE from being mistaken for the config path", () => {
    const cmd = parse(["--hash", "abc123", "--tool", "move_note", "/etc/cfg.json"]);
    expect(cmd).toMatchObject({
      kind: "elicit-mint",
      hash: "abc123",
      tool: "move_note",
      configPath: "/etc/cfg.json",
    });
  });

  it("treats a missing --hash as a USAGE error, so it exits 2 like other parse failures", () => {
    expect(parse(["--tool", "move_note"]).kind).toBe("error");
  });

  it("treats a missing --tool as a USAGE error", () => {
    expect(parse(["--hash", "abc123"]).kind).toBe("error");
  });

  it("has no --ttl flag at all — this command can never mint past elicitTtlSeconds", () => {
    const cmd = parse(["--hash", "abc123", "--tool", "move_note", "--ttl", "999999"]);
    // --ttl is not a recognized flag on `elicit`, so it is read as the config path positional
    // (the same "unfiltered value" trap every other command's parser guards against) rather than
    // silently accepted as a duration override.
    expect(cmd).toMatchObject({ kind: "elicit-mint" });
    expect(cmd).not.toHaveProperty("ttl");
  });

  it("carries --vault, --caller and --json through", () => {
    expect(
      parse([
        "--hash",
        "h1",
        "--tool",
        "delete_note",
        "--vault",
        "main",
        "--caller",
        "alice",
        "--json",
      ]),
    ).toMatchObject({ vault: "main", caller: "alice", json: true });
  });

  it("defaults json to false and omits vault/caller when not given", () => {
    const cmd = parse(["--hash", "h1", "--tool", "delete_note"]);
    expect(cmd).toMatchObject({ json: false });
    expect(cmd).not.toHaveProperty("vault");
    expect(cmd).not.toHaveProperty("caller");
  });
});

describe("parseCliArgs — reflect no longer takes --max-judged (THE-747)", () => {
  // THE-701 removed the episode-eligibility judge; the flag that capped it outlived it by four
  // days, parsed and validated and passed to nothing. These pin the removal.
  it("REJECTS --max-judged rather than ignoring it", () => {
    const cmd = parseCliArgs(["reflect", "--max-judged", "5"]);
    expect(cmd.kind).toBe("error");
    expect((cmd as { message: string }).message).toContain("no longer supported");
  });

  // The load-bearing one. positional() takes the first non-dash token, so a silently-dropped flag
  // would leave its VALUE as the first candidate and resolve the config path to "5".
  it("never lets the dropped flag's VALUE become the config path", () => {
    const cmd = parseCliArgs(["reflect", "--max-judged", "5"]);
    expect(cmd).not.toMatchObject({ kind: "reflect", input: "5" });
  });

  it("still parses a positional path and --config", () => {
    expect(parseCliArgs(["reflect", "/v/cfg.json"])).toMatchObject({
      kind: "reflect",
      input: "/v/cfg.json",
    });
    expect(parseCliArgs(["reflect", "--config", "/v/c.json"])).toMatchObject({
      kind: "reflect",
      input: "/v/c.json",
    });
  });
});

describe("parseCliArgs — citation-infer --max-judged (THE-617 item 3)", () => {
  it("parses --max-judged alongside the config path without eating it as a value", () => {
    const cmd = parseCliArgs([
      "citation-infer",
      "--session",
      "s1",
      "--transcript",
      "t.txt",
      "--max-judged",
      "5",
      "/etc/cfg.json",
    ]);
    expect(cmd).toMatchObject({
      kind: "citation-infer",
      session: "s1",
      transcript: "t.txt",
      maxJudged: 5,
      input: "/etc/cfg.json",
    });
  });

  it("parses --transcript-index without eating the positional config path (THE-717)", () => {
    // The trap the strip list exists for: --transcript-index carries a VALUE, so it must be spliced
    // out two entries at a time or positional() reads its filename as the config path. Its name is
    // also a prefix-superset of --transcript, which is the other way this could go wrong.
    const cmd = parseCliArgs([
      "citation-infer",
      "--transcript-index",
      "idx.jsonl",
      "/etc/cfg.json",
    ]);
    expect(cmd).toMatchObject({
      kind: "citation-infer",
      transcriptIndex: "idx.jsonl",
      input: "/etc/cfg.json",
    });
    // ...and it must not be confused for --transcript, which scopes differently.
    expect((cmd as { transcript?: string }).transcript).toBeUndefined();
  });

  it("parses the valueless --allow-uncertain WITHOUT eating the positional config path", () => {
    // The trap this pins: the value-carrying flags are spliced out of `scan` two entries at a
    // time so positional() cannot mistake a flag's value for the config path. --allow-uncertain
    // takes NO value, so adding it to that strip list would swallow the path after it.
    const cmd = parseCliArgs([
      "citation-infer",
      "--session",
      "s1",
      "--allow-uncertain",
      "/etc/cfg.json",
    ]);
    expect(cmd).toMatchObject({
      kind: "citation-infer",
      session: "s1",
      allowUncertain: true,
      input: "/etc/cfg.json",
    });
  });

  it("omits allowUncertain entirely when the flag is absent — dark by default", () => {
    const cmd = parseCliArgs(["citation-infer", "--session", "s1"]);
    expect(cmd).toMatchObject({ kind: "citation-infer", session: "s1" });
    expect((cmd as { allowUncertain?: boolean }).allowUncertain).toBeUndefined();
  });

  it("rejects a negative or non-numeric --max-judged", () => {
    expect(parseCliArgs(["citation-infer", "--session", "s1", "--max-judged", "-1"]).kind).toBe(
      "error",
    );
    expect(parseCliArgs(["citation-infer", "--session", "s1", "--max-judged", "soon"]).kind).toBe(
      "error",
    );
  });

  it("omits maxJudged entirely when the flag is absent (opts fall back to citation.ts's default)", () => {
    expect(parseCliArgs(["citation-infer", "--session", "s1"])).not.toHaveProperty("maxJudged");
  });
});

describe("parseCliArgs — citation-infer stage-2 preflight knobs (THE-621)", () => {
  it("parses both new flags alongside the config path without eating it as a value", () => {
    const cmd = parseCliArgs([
      "citation-infer",
      "--session",
      "s1",
      "--transcript",
      "t.txt",
      "--judge-concurrency",
      "4",
      "--min-judged-for-kill",
      "25",
      "/etc/cfg.json",
    ]);
    expect(cmd).toMatchObject({
      kind: "citation-infer",
      session: "s1",
      transcript: "t.txt",
      judgeConcurrency: 4,
      minJudgedForKill: 25,
      input: "/etc/cfg.json", // both flags spliced out of `scan`, so the path survives
    });
  });

  it("rejects 0 for both, where --max-judged ACCEPTS 0", () => {
    // The asymmetry is deliberate. Judging 0 survivors is a coherent instruction; a fan-out of 0
    // sends nothing and a kill floor of 0 can never be reached by `judged >= floor`. citation.ts
    // clamps both with Math.max(1, ...), so accepting 0 would hand back a silent 1.
    expect(parseCliArgs(["citation-infer", "--session", "s1", "--max-judged", "0"])).toMatchObject({
      kind: "citation-infer",
      maxJudged: 0,
    });
    expect(
      parseCliArgs(["citation-infer", "--session", "s1", "--judge-concurrency", "0"]).kind,
    ).toBe("error");
    expect(
      parseCliArgs(["citation-infer", "--session", "s1", "--min-judged-for-kill", "0"]).kind,
    ).toBe("error");
  });

  it("rejects negative and non-numeric values for both", () => {
    for (const flag of ["--judge-concurrency", "--min-judged-for-kill"]) {
      expect(parseCliArgs(["citation-infer", "--session", "s1", flag, "-1"]).kind).toBe("error");
      expect(parseCliArgs(["citation-infer", "--session", "s1", flag, "soon"]).kind).toBe("error");
    }
  });

  it("omits both entirely when absent, so citation.ts's defaults apply", () => {
    const cmd = parseCliArgs(["citation-infer", "--session", "s1"]);
    expect(cmd).not.toHaveProperty("judgeConcurrency");
    expect(cmd).not.toHaveProperty("minJudgedForKill");
  });
});

describe("redactConfig — generic key-suffix fields", () => {
  it("masks any *key/*secret/*token field, including signing/private keys", () => {
    const json = JSON.stringify(
      redactConfig({ signingKey: "sk-1", privateKey: "pk-2", publicId: "ok" }),
    );
    expect(json).not.toContain("sk-1");
    expect(json).not.toContain("pk-2");
    expect(json).toContain('"signingKey":"<redacted>"');
    expect(json).toContain('"privateKey":"<redacted>"');
    expect(json).toContain('"publicId":"ok"');
  });
});

// THE-697 — `index` was the conspicuous omission from the CLI. Every other derived-state job here
// (cluster, activation-recompute, note-quality, gaps) has one; indexing was reachable ONLY through
// the index_vault MCP tool or boot reconcile. That mattered because the tool call cannot complete
// over HTTP: Bun's 10s default idleTimeout kills the request while the work continues invisibly
// server-side, so the caller sees a hard failure on a successful operation and an operator has no
// clean path to a scripted reindex.
describe("THE-697 index command", () => {
  it("parses a bare `index`", () => {
    expect(parseCliArgs(["index"])).toStrictEqual({ kind: "index" });
  });

  it("accepts --config, like every other derived-state command", () => {
    expect(parseCliArgs(["index", "--config", "/etc/otc.json"])).toStrictEqual({
      kind: "index",
      input: "/etc/otc.json",
    });
  });

  it("accepts a positional config path", () => {
    expect(parseCliArgs(["index", "/etc/otc.json"])).toStrictEqual({
      kind: "index",
      input: "/etc/otc.json",
    });
  });

  it("scopes to one vault with --vault", () => {
    expect(parseCliArgs(["index", "--vault", "main"])).toStrictEqual({
      kind: "index",
      vault: "main",
    });
  });

  it("does not mistake --vault's value for the config positional", () => {
    // The trap every other command here had to handle explicitly: `positional(rest)` would
    // otherwise read "main" as the config path and try to load a file called `main`.
    expect(parseCliArgs(["index", "--vault", "main"])).toStrictEqual({
      kind: "index",
      vault: "main",
    });
  });

  it("scopes to a subfolder with --folder", () => {
    expect(parseCliArgs(["index", "--folder", "Notes/Daily"])).toStrictEqual({
      kind: "index",
      folder: "Notes/Daily",
    });
  });
});

describe("THE-645 item 3 — parseCliArgs rerun", () => {
  it("bare session id, no path", () => {
    expect(parseCliArgs(["rerun", "sess_1"])).toStrictEqual({
      kind: "rerun",
      sessionId: "sess_1",
    });
  });

  it("missing session id is a usage error, not a silent fall-through to serve", () => {
    expect(parseCliArgs(["rerun"])).toStrictEqual({
      kind: "error",
      message: "rerun requires a session id",
    });
  });

  // Fix round 1, finding 2: a naive implementation only ever found the FIRST non-flag token
  // (the session id) and never looked for a second one, so the documented `[path]` positional
  // (USAGE: `rerun <session-id> [path] ...`) was silently discarded — a re-run would fall through
  // to OBSIDIAN_TC_CONFIG or the zero-config default instead of the vault the operator named.
  it("a second positional after the session id becomes the config path — the documented [path] form", () => {
    expect(parseCliArgs(["rerun", "sess_1", "/etc/otc.json"])).toStrictEqual({
      kind: "rerun",
      sessionId: "sess_1",
      input: "/etc/otc.json",
    });
  });

  it("--config is honoured the same as a positional path", () => {
    expect(parseCliArgs(["rerun", "sess_1", "--config", "/etc/otc.json"])).toStrictEqual({
      kind: "rerun",
      sessionId: "sess_1",
      input: "/etc/otc.json",
    });
  });

  it("does not mistake --vault's value for the config positional", () => {
    // The same trap `index` (above) had to handle: with `--vault` left in `scan`, `positional`
    // would read the vault id itself as the config path.
    expect(parseCliArgs(["rerun", "sess_1", "--vault", "main"])).toStrictEqual({
      kind: "rerun",
      sessionId: "sess_1",
      vault: "main",
    });
  });

  it("carries --sandbox and --json through as booleans, omitted when absent", () => {
    expect(parseCliArgs(["rerun", "sess_1", "--sandbox", "--json"])).toStrictEqual({
      kind: "rerun",
      sessionId: "sess_1",
      sandbox: true,
      json: true,
    });
  });

  it("parses session id, path, --vault and --sandbox together", () => {
    expect(
      parseCliArgs(["rerun", "sess_1", "/vault/dir", "--vault", "main", "--sandbox"]),
    ).toStrictEqual({
      kind: "rerun",
      sessionId: "sess_1",
      input: "/vault/dir",
      vault: "main",
      sandbox: true,
    });
  });
});

describe("THE-636 — parseCliArgs context-export", () => {
  it("bare context-export carries no --out (run_context_export enforces it, like forget's flags)", () => {
    expect(parseCliArgs(["context-export"])).toStrictEqual({ kind: "context-export" });
  });

  it("--out is captured", () => {
    expect(parseCliArgs(["context-export", "--out", "/tmp/bundle.json"])).toStrictEqual({
      kind: "context-export",
      out: "/tmp/bundle.json",
    });
  });

  it("--vault narrows the export", () => {
    expect(
      parseCliArgs(["context-export", "--out", "/tmp/bundle.json", "--vault", "main"]),
    ).toStrictEqual({
      kind: "context-export",
      out: "/tmp/bundle.json",
      vault: "main",
    });
  });

  it("accepts a positional config path alongside --out", () => {
    expect(
      parseCliArgs(["context-export", "/etc/otc.json", "--out", "/tmp/bundle.json"]),
    ).toStrictEqual({
      kind: "context-export",
      input: "/etc/otc.json",
      out: "/tmp/bundle.json",
    });
  });

  it("does not mistake --out's or --vault's value for the config positional", () => {
    expect(
      parseCliArgs(["context-export", "--out", "/tmp/bundle.json", "--vault", "main"]),
    ).toStrictEqual({
      kind: "context-export",
      out: "/tmp/bundle.json",
      vault: "main",
    });
  });
});

describe("THE-636 — parseCliArgs context-import", () => {
  it("bare context-import carries no bundlePath (run_context_import enforces it)", () => {
    expect(parseCliArgs(["context-import"])).toStrictEqual({ kind: "context-import" });
  });

  it("captures the bundle path as the first non-flag positional", () => {
    expect(parseCliArgs(["context-import", "/tmp/bundle.json"])).toStrictEqual({
      kind: "context-import",
      bundlePath: "/tmp/bundle.json",
    });
  });

  it("a second positional after the bundle path becomes the config path — same shape as rerun", () => {
    expect(parseCliArgs(["context-import", "/tmp/bundle.json", "/etc/otc.json"])).toStrictEqual({
      kind: "context-import",
      bundlePath: "/tmp/bundle.json",
      input: "/etc/otc.json",
    });
  });

  it("--config is honoured the same as a positional config path", () => {
    expect(
      parseCliArgs(["context-import", "/tmp/bundle.json", "--config", "/etc/otc.json"]),
    ).toStrictEqual({
      kind: "context-import",
      bundlePath: "/tmp/bundle.json",
      input: "/etc/otc.json",
    });
  });

  it("does not mistake --vault's value for the config positional", () => {
    expect(parseCliArgs(["context-import", "/tmp/bundle.json", "--vault", "main"])).toStrictEqual({
      kind: "context-import",
      bundlePath: "/tmp/bundle.json",
      vault: "main",
    });
  });

  it("carries --dry-run through as a boolean, omitted when absent", () => {
    expect(parseCliArgs(["context-import", "/tmp/bundle.json", "--dry-run"])).toStrictEqual({
      kind: "context-import",
      bundlePath: "/tmp/bundle.json",
      dryRun: true,
    });
    expect(parseCliArgs(["context-import", "/tmp/bundle.json"])).not.toHaveProperty("dryRun");
  });

  it("parses bundle path, config path, --vault and --dry-run together", () => {
    expect(
      parseCliArgs([
        "context-import",
        "/tmp/bundle.json",
        "/etc/otc.json",
        "--vault",
        "main",
        "--dry-run",
      ]),
    ).toStrictEqual({
      kind: "context-import",
      bundlePath: "/tmp/bundle.json",
      input: "/etc/otc.json",
      vault: "main",
      dryRun: true,
    });
  });
});

describe("THE-650 — parseCliArgs import-highlights", () => {
  it("bare import-highlights carries no vault (run_import_highlights enforces it)", () => {
    expect(parseCliArgs(["import-highlights"])).toStrictEqual({ kind: "import-highlights" });
  });

  it("--vault is captured", () => {
    expect(parseCliArgs(["import-highlights", "--vault", "main"])).toStrictEqual({
      kind: "import-highlights",
      vault: "main",
    });
  });

  it("a positional becomes the config path, same as every other command", () => {
    expect(parseCliArgs(["import-highlights", "/etc/otc.json", "--vault", "main"])).toStrictEqual({
      kind: "import-highlights",
      configPath: "/etc/otc.json",
      vault: "main",
    });
  });

  it("--config is honoured the same as a positional config path", () => {
    expect(
      parseCliArgs(["import-highlights", "--config", "/etc/otc.json", "--vault", "main"]),
    ).toStrictEqual({ kind: "import-highlights", configPath: "/etc/otc.json", vault: "main" });
  });

  it("--since is captured and does not consume the config positional", () => {
    expect(
      parseCliArgs(["import-highlights", "--vault", "main", "--since", "2026-08-01T00:00:00Z"]),
    ).toStrictEqual({
      kind: "import-highlights",
      vault: "main",
      since: "2026-08-01T00:00:00Z",
    });
  });

  it("carries --dry-run through as a boolean, omitted when absent", () => {
    expect(parseCliArgs(["import-highlights", "--vault", "main", "--dry-run"])).toStrictEqual({
      kind: "import-highlights",
      vault: "main",
      dryRun: true,
    });
    expect(parseCliArgs(["import-highlights", "--vault", "main"])).not.toHaveProperty("dryRun");
  });

  it("--vault with no value is a usage error", () => {
    expect(parseCliArgs(["import-highlights", "--vault"])).toStrictEqual({
      kind: "error",
      message: "--vault requires a value",
    });
  });
});

describe("parseCliArgs — note-quality --suggest (THE-643)", () => {
  it("is omitted when absent, matching every other boolean flag's convention", () => {
    expect(parseCliArgs(["note-quality"])).not.toHaveProperty("suggest");
  });

  it("carries --suggest through as a boolean", () => {
    expect(parseCliArgs(["note-quality", "--suggest"])).toMatchObject({
      kind: "note-quality",
      suggest: true,
    });
  });

  it("doesn't get swallowed by the config-path positional scan, and combines with other flags", () => {
    expect(
      parseCliArgs([
        "note-quality",
        "/vault/dir",
        "--vault",
        "main",
        "--flags",
        "duplicate,orphan",
        "--limit",
        "5",
        "--suggest",
      ]),
    ).toMatchObject({
      kind: "note-quality",
      input: "/vault/dir",
      vault: "main",
      flags: ["duplicate", "orphan"],
      limit: 5,
      suggest: true,
    });
  });
});
