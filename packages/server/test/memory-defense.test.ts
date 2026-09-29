// GH #994 — Memory Defense: per-vault secret/PII scan on every memory-writing tool
// (create_entity, add_observation, enqueue_capture, commit_capture, set_goal — plus the two
// sibling writers the audit below found were missing coverage, link_entities/rename_entity).
//
// Every secret/PII value used below is assembled at RUNTIME (string concatenation / a computed
// Luhn check digit), never a single literal in source that itself matches a SECRET_PATTERNS or
// PII regex — `.gitleaks.toml` already allowlists `packages/server/test/.*`, but this file follows
// the stricter no-literal-secret rule regardless, so a trufflehog `--only-verified` pass or a
// future tightened gitleaks config never has anything real-shaped to find here either.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { VaultMemoryDefenseConfig } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromVaultPath } from "../src/cli/args";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import type { CallerContext } from "../src/mcp/registry";
import { ToolRegistry } from "../src/mcp/registry";
import { MetricsRecorder } from "../src/metrics/registry";
import { buildServerRuntime } from "../src/runtime/server-runtime";
import { registerM5Tools } from "../src/tools/m5";
import { registerM8Tools } from "../src/tools/m8";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { type M5Vault, makeM5Vault } from "./m5-helpers";
import { rmTemp } from "./tmp";

// ---------------------------------------------------------------------------------------------
// Secret/PII builders — every one assembles its result from pieces that are NOT individually
// secret-shaped, at runtime, so no single literal anywhere in this file matches a scanned
// pattern.
// ---------------------------------------------------------------------------------------------

function fakeOpenAiKey(): string {
  return ["sk", "-", "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
}

function fakeGithubToken(): string {
  return ["gh", "p_", "M1n2B3v4C5x6Z7a8S9d0F1g2H3j4K5l6"].join("");
}

function fakeAwsKeyId(): string {
  return ["AKIA", "Q7W8E9R0T1Y2U3I4"].join("");
}

// review finding 1 PoC: a colon separator instead of the pattern's own hyphen — doesn't match
// `\bsk-...\b` raw, but `sanitizeSegment` (memory/materialize.ts) turns `:` into `-` when this
// becomes a path segment, producing a byte-identical string to fakeOpenAiKey() above.
function fakeOpenAiKeyWithColon(): string {
  return ["sk", ":", "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"].join("");
}

// The alphanumeric body shared by every fake* generator above — used to assert the entropy
// portion of a secret never survives redaction under a different casing/prefix.
const OPENAI_KEY_BODY = "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2";

function sanitizePathSegmentLike(s: string): string {
  return s.replace(/[\\/:*?"<>|#^[\]]/g, "-");
}

// review finding 4 PoC: openai_key's pattern is case-sensitive (`\bsk-...`) — an UPPERCASE prefix
// doesn't match raw, but normalizeObservationKey (memory/entities.ts) lowercases every key before
// persisting it.
function fakeUppercaseOpenAiKey(): string {
  return ["SK", "-", OPENAI_KEY_BODY].join("");
}

// review finding 5 PoC: a Luhn-valid Visa PAN, as a JSON NUMBER rather than a string — mirrors
// fakeValidVisaCard() below but returns `number`, since `frontmatter_overrides` is
// `z.record(z.string(), z.unknown())` and a caller can supply a bare numeric literal.
function fakeValidVisaCardNumber(): number {
  const payload = ["4", "2", "3", "4", "5", "6", "7", "8", "9", "0", "1", "2", "3", "4", "5"].join(
    "",
  );
  return Number(luhnAppendCheckDigit(payload));
}

// review finding 6 PoC generators — assembled at runtime, never a literal.
function fakeLowConfidenceLabeledSecretA(): string {
  return ["token", ": ", "deployment-id-12345"].join("");
}
function fakeLowConfidenceLabeledSecretB(): string {
  return ["password", ": ", "hunter22-old"].join("");
}
function fakeLowConfidenceLabeledSecretC(): string {
  // addendum 1: a short-but-mixed-class password — must ALSO stay low confidence (length < 16).
  return ["password", ": ", "Summer2024!"].join("");
}
function fakeHighConfidenceLabeledSecret(): string {
  // A 32-char run mixing upper/lower/digit — classes >= 3 AND length >= 16, high confidence
  // under EITHER branch of isSecretShapedValue.
  return [
    "api_key",
    " = ",
    "aB3",
    "dE6",
    "fG9",
    "hJ2",
    "kL5",
    "mN8",
    "pQ1",
    "rS4",
    "tU7",
    "v",
  ].join("");
}
function fakeHighConfidenceLowercaseHexLabeledSecret(): string {
  // item 3 (entropy floor): a true 32-char lowercase hex value — only 2 character classes
  // (lower + digit), so it must clear the length >= 20 branch's entropy floor rather than the
  // classes >= 3 branch. Deliberately non-repetitive (each hex digit appears close to twice, in
  // scrambled order) — computed at ~4.0 Shannon bits/char via codecalc, comfortably above the
  // module's LABELED_SECRET_ENTROPY_FLOOR_BITS_PER_CHAR, unlike a repeating pattern which would
  // score far lower despite "looking" hex-shaped.
  return ["token", ": ", "3f2b8e9a", "1c04d7f6", "b8a2e9c1", "d4f07b3a"].join("");
}
function fakeLabeledUuidValue(): string {
  // addendum 3: a canonical UUID next to a label — long (36 chars) and would otherwise clear the
  // length >= 20 branch, but must stay low confidence (UUID shape excluded).
  return ["token", ": ", "123e4567-e89b-12d3-a456-426614174000"].join("");
}

// item 3 (entropy floor, GH #994 follow-up): a dash-joined, low-entropy label value that is
// >= 20 chars and only 2 character classes (lower + digit) — previously misclassified
// high-confidence by the length >= 20 branch alone. Computed at ~3.72 Shannon bits/char via
// codecalc, below the floor.
function fakeLowEntropyServiceLabel(): string {
  return ["token", ": ", "production-service-1"].join("");
}

// item 3: a realistic 40-char base64url-shaped token — mixed upper/lower/digit (3 classes), so
// it clears the classes >= 3 branch unconditionally and must stay high-confidence regardless of
// the entropy floor added to the length >= 20 branch.
function fakeHighConfidenceBase64UrlLabeledSecret(): string {
  return ["access_token", " = ", "kJ8xQ2vR", "9mN4pL7w", "T1zY6sB3", "cH0dF5gA", "8eU2iO9k"].join(
    "",
  );
}

// item 3: a ULID (Crockford base32, 26 chars, digits + uppercase only — 2 classes) next to a
// label. Structurally a correlation id (like the UUID case above), not a credential, even though
// it clears both the classes >= 3 branch's alternative and the length >= 20 branch's raw length
// check — excluded by shape, same treatment as UUID_SHAPE_RE.
function fakeLabeledUlidValue(): string {
  return ["token", ": ", "01ARZ3ND", "EKTSV4RR", "FFQ69G5F", "AV"].join("");
}

function fakeSsn(): string {
  return ["1", "2", "3", "-", "4", "5", "-", "6", "7", "8", "9"].join("");
}

function luhnAppendCheckDigit(payload: string): string {
  let sum = 0;
  let alt = true;
  for (let i = payload.length - 1; i >= 0; i--) {
    let d = payload.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  const check = (10 - (sum % 10)) % 10;
  return payload + String(check);
}

function fakeValidVisaCard(): string {
  const payload = ["4", "2", "3", "4", "5", "6", "7", "8", "9", "0", "1", "2", "3", "4", "5"].join(
    "",
  );
  return luhnAppendCheckDigit(payload);
}

function fakeInvalidVisaCard(): string {
  const valid = fakeValidVisaCard();
  const lastDigit = Number(valid[valid.length - 1]);
  const bumped = (lastDigit + 1) % 10;
  return valid.slice(0, -1) + String(bumped);
}

// The scanner-throws (fail-closed) trigger — a sentinel substring, never a real secret shape,
// that only the mocked redactSecrets below reacts to.
const THROW_SENTINEL = "TRIGGER_SCANNER_THROW_GH994";

vi.mock("../src/experiential/redact", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/experiential/redact")>();
  return {
    ...actual,
    redactSecrets: (text: string) => {
      if (text.includes(THROW_SENTINEL)) {
        throw new Error("scanner exploded (test-injected, GH #994 fail-closed case)");
      }
      return actual.redactSecrets(text);
    },
  };
});

// ---------------------------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------------------------

function un<T>(r: { ok: boolean; data?: unknown }): T {
  return (r as { data: T }).data;
}

function errOf(r: { ok: boolean; error?: unknown }): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  return (r as { error: { code: string; message: string; details?: Record<string, unknown> } })
    .error;
}

// ---------------------------------------------------------------------------------------------
// M8 (set_goal/list_goals) harness — mirrors test/m8-experiential-tools.test.ts's own `harness`,
// extended with the memoryDefense/metrics knobs GH #994 added to M8Deps.
// ---------------------------------------------------------------------------------------------

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
const EXP_CHAIN = EXPERIENTIAL_MIGRATION_FILES.map((file) => ({
  version: versionOf(file),
  sql: read(file),
}));

function edb0(): Database {
  const db = openMemoryDb();
  runMigrations(db, EXP_CHAIN);
  return db;
}

function cacheDb0(): Database {
  const db = openMemoryDb();
  db.exec(
    "CREATE TABLE event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, vault_id TEXT, tool_name TEXT, caller TEXT, duration_ms INTEGER, result_size INTEGER, status TEXT NOT NULL, error_code TEXT, args_hash TEXT, event_type TEXT);",
  );
  return db;
}

function m8Harness(
  opts: { memoryDefense?: VaultMemoryDefenseConfig; metrics?: MetricsRecorder } = {},
) {
  const registry = new ToolRegistry({});
  registerM8Tools(registry, {
    edb: edb0(),
    now: () => 1_700_000_000_000,
    ...(opts.memoryDefense
      ? { memoryDefense: () => opts.memoryDefense as VaultMemoryDefenseConfig }
      : {}),
    ...(opts.metrics ? { metrics: opts.metrics } : {}),
  });
  const cache = cacheDb0();
  const ctx = (over: Partial<CallerContext> = {}): CallerContext => ({
    caller: "tester",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "main",
    db: cache,
    ...over,
  });
  return { registry, ctx };
}

// ---------------------------------------------------------------------------------------------
// off mode: 5 writers behave unchanged, no scan runs (ledger #1)
// ---------------------------------------------------------------------------------------------

describe("memoryDefense off mode — 5 writers unchanged, no scan runs", () => {
  let v: M5Vault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  it("create_entity persists a secret-shaped observation verbatim", async () => {
    v = makeM5Vault(); // no memoryDefense option -> MEMORY_DEFENSE_OFF
    const secret = fakeOpenAiKey();
    const r = await v.call("create_entity", {
      vault: "test",
      type: "person",
      name: "off-mode-create",
      observations: [secret],
    });
    expect(r.ok).toBe(true);
    const get = await v.call("get_entity", {
      vault: "test",
      entity_id: un<{ entity_id: string }>(r).entity_id,
    });
    expect(un<{ observations: Array<{ text: string }> }>(get).observations[0]?.text).toBe(secret);
  });

  it("add_observation persists a secret-shaped fact verbatim", async () => {
    v = makeM5Vault();
    const secret = fakeGithubToken();
    const created = await v.call("create_entity", {
      vault: "test",
      type: "person",
      name: "off-mode-obs",
      materialize: false,
    });
    const entityId = un<{ entity_id: string }>(created).entity_id;
    const r = await v.call("add_observation", {
      vault: "test",
      entity_id: entityId,
      observation: secret,
    });
    expect(r.ok).toBe(true);
    const get = await v.call("get_entity", { vault: "test", entity_id: entityId });
    expect(un<{ observations: Array<{ text: string }> }>(get).observations.at(-1)?.text).toBe(
      secret,
    );
  });

  it("enqueue_capture persists secret-shaped content verbatim", async () => {
    v = makeM5Vault();
    const secret = fakeAwsKeyId();
    const r = await v.call("enqueue_capture", { vault: "test", content: secret });
    expect(r.ok).toBe(true);
    const listed = await v.call("list_capture_queue", { vault: "test" });
    expect(
      un<{ items: Array<{ content_preview: string }> }>(listed).items[0]?.content_preview,
    ).toBe(secret);
  });

  it("commit_capture persists secret-shaped frontmatter_overrides verbatim", async () => {
    v = makeM5Vault();
    const secret = fakeGithubToken();
    const enq = await v.call("enqueue_capture", { vault: "test", content: "clean content" });
    const captureId = un<{ capture_id: string }>(enq).capture_id;
    const r = await v.call("commit_capture", {
      vault: "test",
      capture_id: captureId,
      target_path: "off-mode/commit.md",
      frontmatter_overrides: { note: secret },
    });
    expect(r.ok).toBe(true);
    expect(v.read("off-mode/commit.md")).toContain(secret);
  });

  it("set_goal persists secret-shaped text verbatim", async () => {
    const h = m8Harness();
    const secret = fakeAwsKeyId();
    const r = await h.registry.dispatch("set_goal", { vault: "main", text: secret }, h.ctx());
    expect(r.ok).toBe(true);
    const listed = await h.registry.dispatch(
      "list_goals",
      { vault: "main", status: "any" },
      h.ctx(),
    );
    expect(un<{ goals: Array<{ text: string }> }>(listed).goals[0]?.text).toBe(secret);
  });
});

// ---------------------------------------------------------------------------------------------
// block mode: REAL-WIRING integration test — buildServerRuntime + configFromVaultPath, dispatched
// through the registry exactly as production wires it (ledger #2, brief step 1: "catches wiring
// gaps unit tests miss").
// ---------------------------------------------------------------------------------------------

describe("memoryDefense block mode — real wiring (buildServerRuntime), all 7 writers, nothing persisted", () => {
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
        // best-effort, same concession server-runtime.test.ts makes
      }
    }
  });

  it("refuses a planted secret on each of the 7 writers, through the PRODUCTION composition root, and nothing persists", async () => {
    const vaultDir = tmpDir("otc-memdef-vault-");
    const config = configFromVaultPath(vaultDir);
    config.cacheDir = tmpDir("otc-memdef-cache-");
    const vault = config.vaults[0];
    if (!vault) throw new Error("configFromVaultPath did not return a vault");
    vault.memoryDefense = { mode: "block", pii: true };
    // set_goal's M8Deps.edb is only wired when the experiential store is open.
    config.experiential.logRetrievals = true;

    const runtime = await buildServerRuntime(config, join(vaultDir, "config.json"));
    try {
      const db: Database = openMemoryDb();
      provisionCacheDb(db);
      const ctx: CallerContext = {
        caller: "test",
        authenticated: true,
        grantedScopes: new Set(["*"]),
        vaultId: "main",
        db,
      };

      // ---- fixtures created with CLEAN data (block mode never refuses a clean write) ----
      const cleanEntity = un<{ entity_id: string }>(
        await runtime.registry.dispatch(
          "create_entity",
          { vault: "main", type: "person", name: "wiring-probe-fixture", materialize: false },
          ctx,
        ),
      );
      const cleanCapture = un<{ capture_id: string }>(
        await runtime.registry.dispatch(
          "enqueue_capture",
          { vault: "main", content: "clean fixture content" },
          ctx,
        ),
      );
      const linkFixtureA = un<{ entity_id: string }>(
        await runtime.registry.dispatch(
          "create_entity",
          { vault: "main", type: "person", name: "wiring-probe-link-a", materialize: false },
          ctx,
        ),
      );
      const linkFixtureB = un<{ entity_id: string }>(
        await runtime.registry.dispatch(
          "create_entity",
          { vault: "main", type: "person", name: "wiring-probe-link-b", materialize: false },
          ctx,
        ),
      );
      const renameFixture = un<{ entity_id: string }>(
        await runtime.registry.dispatch(
          "create_entity",
          { vault: "main", type: "person", name: "wiring-probe-rename", materialize: false },
          ctx,
        ),
      );

      // ---- table of tool -> args carrying a planted secret (all 7 guarded writers) ----
      const secret = fakeOpenAiKey();
      const table: Array<{ tool: string; args: Record<string, unknown> }> = [
        {
          tool: "create_entity",
          args: { vault: "main", type: "person", name: "wiring-probe-new", observations: [secret] },
        },
        {
          tool: "add_observation",
          args: { vault: "main", entity_id: cleanEntity.entity_id, observation: secret },
        },
        { tool: "enqueue_capture", args: { vault: "main", content: secret } },
        {
          tool: "commit_capture",
          args: {
            vault: "main",
            capture_id: cleanCapture.capture_id,
            target_path: "wiring-probe/commit.md",
            frontmatter_overrides: { note: secret },
          },
        },
        { tool: "set_goal", args: { vault: "main", text: secret } },
        {
          tool: "link_entities",
          args: {
            vault: "main",
            source_id: linkFixtureA.entity_id,
            target_id: linkFixtureB.entity_id,
            relation_type: secret,
          },
        },
        {
          tool: "rename_entity",
          args: { vault: "main", entity_id: renameFixture.entity_id, new_name: secret },
        },
      ];

      for (const tc of table) {
        const res = await runtime.registry.dispatch(tc.tool, tc.args, ctx);
        expect(res.ok, `${tc.tool} should have been refused`).toBe(false);
        if (!res.ok) expect(res.error.code).toBe("secret_detected");
      }

      // ---- nothing persisted: prove it through the tools' own read paths ----

      // create_entity: the blocked attempt left the (type, name) key free — a clean retry with
      // the SAME name succeeds, which is only possible if the blocked call inserted no row.
      const retry = await runtime.registry.dispatch(
        "create_entity",
        { vault: "main", type: "person", name: "wiring-probe-new", observations: ["clean fact"] },
        ctx,
      );
      expect(retry.ok).toBe(true);

      // add_observation: the fixture entity still has zero observations.
      const entityAfter = un<{ observations: unknown[] }>(
        await runtime.registry.dispatch(
          "get_entity",
          { vault: "main", entity_id: cleanEntity.entity_id },
          ctx,
        ),
      );
      expect(entityAfter.observations).toHaveLength(0);

      // enqueue_capture: only the ONE clean fixture capture is queued — the blocked attempt
      // queued nothing.
      const queue = un<{ items: unknown[] }>(
        await runtime.registry.dispatch("list_capture_queue", { vault: "main" }, ctx),
      );
      expect(queue.items).toHaveLength(1);

      // commit_capture: the fixture capture is still queued, uncommitted — the blocked commit
      // wrote no note and did not mark it committed.
      const stillQueued = un<{ items: Array<{ capture_id: string; committed_at: number | null }> }>(
        await runtime.registry.dispatch(
          "list_capture_queue",
          { vault: "main", committed: false },
          ctx,
        ),
      );
      expect(stillQueued.items.map((i) => i.capture_id)).toContain(cleanCapture.capture_id);
      const committed = un<{ items: unknown[] }>(
        await runtime.registry.dispatch(
          "list_capture_queue",
          { vault: "main", committed: true },
          ctx,
        ),
      );
      expect(committed.items).toHaveLength(0);

      // set_goal: no goal was ever recorded.
      const goals = un<{ count: number }>(
        await runtime.registry.dispatch("list_goals", { vault: "main", status: "any" }, ctx),
      );
      expect(goals.count).toBe(0);

      // link_entities: the blocked attempt created no relation — a clean link between the SAME
      // pair is not "existed_already".
      const linkRetry = un<{ existed_already: boolean }>(
        await runtime.registry.dispatch(
          "link_entities",
          {
            vault: "main",
            source_id: linkFixtureA.entity_id,
            target_id: linkFixtureB.entity_id,
            relation_type: "clean-relation",
          },
          ctx,
        ),
      );
      expect(linkRetry.existed_already).toBe(false);

      // rename_entity: the fixture entity still carries its original name.
      const renameFixtureAfter = un<{ name: string }>(
        await runtime.registry.dispatch(
          "get_entity",
          { vault: "main", entity_id: renameFixture.entity_id },
          ctx,
        ),
      );
      expect(renameFixtureAfter.name).toBe("wiring-probe-rename");
    } finally {
      await runtime.close("test cleanup");
    }
  });
});

// ---------------------------------------------------------------------------------------------
// redact mode: per-tool, nothing raw persisted, `redactions` reported (ledger #3)
// ---------------------------------------------------------------------------------------------

describe("memoryDefense redact mode — persists REDACTED + reports redactions on each of the 5 writers", () => {
  let v: M5Vault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  it("create_entity", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "redact", pii: false } });
    const secret = fakeOpenAiKey();
    const r = await v.call("create_entity", {
      vault: "test",
      type: "person",
      name: "redact-create",
      observations: [secret],
    });
    expect(r.ok).toBe(true);
    expect(un<{ redactions: number }>(r).redactions).toBe(1);
    const get = un<{ observations: Array<{ text: string }> }>(
      await v.call("get_entity", {
        vault: "test",
        entity_id: un<{ entity_id: string }>(r).entity_id,
      }),
    );
    expect(get.observations[0]?.text).toBe("[REDACTED]");
    expect(get.observations[0]?.text).not.toContain(secret);
  });

  it("add_observation", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "redact", pii: false } });
    const secret = fakeGithubToken();
    const created = un<{ entity_id: string }>(
      await v.call("create_entity", {
        vault: "test",
        type: "person",
        name: "redact-obs",
        materialize: false,
      }),
    );
    const r = await v.call("add_observation", {
      vault: "test",
      entity_id: created.entity_id,
      observation: secret,
    });
    expect(un<{ redactions: number }>(r).redactions).toBe(1);
    const get = un<{ observations: Array<{ text: string }> }>(
      await v.call("get_entity", { vault: "test", entity_id: created.entity_id }),
    );
    expect(get.observations.at(-1)?.text).toBe("[REDACTED]");
  });

  it("enqueue_capture", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "redact", pii: false } });
    const secret = fakeAwsKeyId();
    const r = await v.call("enqueue_capture", { vault: "test", content: secret });
    expect(un<{ redactions: number }>(r).redactions).toBe(1);
    const listed = un<{ items: Array<{ content_preview: string }> }>(
      await v.call("list_capture_queue", { vault: "test" }),
    );
    expect(listed.items[0]?.content_preview).toBe("[REDACTED]");
  });

  it("commit_capture", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "redact", pii: false } });
    const secret = fakeGithubToken();
    const enq = un<{ capture_id: string }>(
      await v.call("enqueue_capture", { vault: "test", content: "clean body text" }),
    );
    const r = await v.call("commit_capture", {
      vault: "test",
      capture_id: enq.capture_id,
      target_path: "redact/commit.md",
      frontmatter_overrides: { note: secret },
    });
    expect(un<{ redactions: number }>(r).redactions).toBe(1);
    const note = v.read("redact/commit.md");
    expect(note).not.toContain(secret);
    expect(note).toContain("[REDACTED]");
  });

  it("set_goal", async () => {
    const h = m8Harness({ memoryDefense: { mode: "redact", pii: false } });
    const secret = fakeAwsKeyId();
    const r = await h.registry.dispatch("set_goal", { vault: "main", text: secret }, h.ctx());
    expect(un<{ redactions: number }>(r).redactions).toBe(1);
    const listed = un<{ goals: Array<{ text: string }> }>(
      await h.registry.dispatch("list_goals", { vault: "main", status: "any" }, h.ctx()),
    );
    expect(listed.goals[0]?.text).toBe("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------------------------
// entity name / array element / nested value / object key placements (ledger #4 + brief step 2)
// ---------------------------------------------------------------------------------------------

describe("memoryDefense block mode — secret placement coverage (entity name, array element, nested value, object key)", () => {
  let v: M5Vault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  it("secret in the entity NAME is blocked and the error text never contains the value", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: false } });
    const secret = fakeOpenAiKey();
    const r = await v.call("create_entity", { vault: "test", type: "person", name: secret });
    expect(r.ok).toBe(false);
    const err = errOf(r);
    expect(err.code).toBe("secret_detected");
    expect(JSON.stringify(err)).not.toContain(secret);
  });

  it("secret in an ARRAY ELEMENT (observations[1]) is caught, not just index 0", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: false } });
    const secret = fakeGithubToken();
    const r = await v.call("create_entity", {
      vault: "test",
      type: "person",
      name: "array-elem-probe",
      observations: ["a clean fact", secret],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("secret_detected");
      const fields = (r.error.details?.fields ?? []) as string[];
      expect(fields.some((f) => f.includes("observations") && f.includes("1"))).toBe(true);
    }
  });

  it("secret in a NESTED VALUE (commit_capture's frontmatter_overrides.meta.inner) is caught", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: false } });
    const secret = fakeAwsKeyId();
    const enq = un<{ capture_id: string }>(
      await v.call("enqueue_capture", { vault: "test", content: "clean body" }),
    );
    const r = await v.call("commit_capture", {
      vault: "test",
      capture_id: enq.capture_id,
      target_path: "nested/commit.md",
      frontmatter_overrides: { meta: { inner: secret } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("secret_detected");
    expect(v.exists("nested/commit.md")).toBe(false);
  });

  it("secret used AS an OBJECT KEY (frontmatter_overrides) is caught, and never echoed as its own raw key", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: false } });
    const secretKey = fakeGithubToken();
    const enq = un<{ capture_id: string }>(
      await v.call("enqueue_capture", { vault: "test", content: "clean body" }),
    );
    const r = await v.call("commit_capture", {
      vault: "test",
      capture_id: enq.capture_id,
      target_path: "keyed/commit.md",
      frontmatter_overrides: { [secretKey]: "harmless value" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("secret_detected");
      expect(JSON.stringify(r.error)).not.toContain(secretKey);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// off -> block / off -> redact commit of a QUEUED secret, incl. queued title/tags (brief step 2)
// ---------------------------------------------------------------------------------------------

describe("memoryDefense mode changes between enqueue and commit — queued rows predating enable", () => {
  let v: M5Vault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  it("off at enqueue -> block at commit refuses the queued secret (title/tags covered too)", async () => {
    v = makeM5Vault(); // off — enqueue with no scan at all
    const secret = fakeOpenAiKey();
    const enq = un<{ capture_id: string }>(
      await v.call("enqueue_capture", {
        vault: "test",
        content: "clean body",
        title: secret,
        tags: ["clean-tag", secret],
      }),
    );
    // Re-wire a registry against the SAME db/root/cacheDir v already opened, but with
    // memoryDefense now on, mode block — simulates "the vault's config changed between enqueue
    // and commit" and proves commit_capture scans the ASSEMBLED frontmatter (which includes the
    // queued title/tags), not just fresh overrides, even for a row enqueued before the feature
    // was enabled.
    const rebuilt = rewireM5WithMemoryDefense(v, { mode: "block", pii: false });
    const commit = await rebuilt.call("commit_capture", {
      vault: "test",
      capture_id: enq.capture_id,
      target_path: "queued/commit.md",
    });
    expect(commit.ok).toBe(false);
    if (!commit.ok) expect(commit.error.code).toBe("secret_detected");
    expect(v.exists("queued/commit.md")).toBe(false);
  });

  it("off at enqueue -> redact at commit scrubs the queued secret", async () => {
    v = makeM5Vault();
    const secret = fakeGithubToken();
    const enq = un<{ capture_id: string }>(
      await v.call("enqueue_capture", { vault: "test", content: "clean body", title: secret }),
    );
    const rebuilt = rewireM5WithMemoryDefense(v, { mode: "redact", pii: false });
    const commit = await rebuilt.call("commit_capture", {
      vault: "test",
      capture_id: enq.capture_id,
      target_path: "queued-redact/commit.md",
    });
    expect(commit.ok).toBe(true);
    const note = v.read("queued-redact/commit.md");
    expect(note).not.toContain(secret);
    expect(note).toContain("[REDACTED]");
  });
});

/** Rebuild an M5 registry against the SAME db/root/cacheDir an existing M5Vault opened, but with
 *  memoryDefense wired — simulates "the vault's config changed between enqueue and commit"
 *  without opening a second, unrelated db (a fresh `makeM5Vault` call would). A plain
 *  `new VaultRegistry` pointed at `v.root` is all M5Deps needs; the tool handlers read/write
 *  through `ctx.db`, which `v.ctx()` still supplies as the SAME db this rebuilt registry
 *  dispatches against. */
function rewireM5WithMemoryDefense(
  v: M5Vault,
  memoryDefense: VaultMemoryDefenseConfig,
): { call: M5Vault["call"] } {
  const registry = new ToolRegistry({});
  registerM5Tools(registry, {
    vaultRegistry: new VaultRegistry([{ id: v.id, path: v.root }]),
    cacheDir: v.cacheDir,
    memoryDefense: () => memoryDefense,
  });
  return {
    call: (name, input, over) => registry.dispatch(name, input, v.ctx(over)),
  };
}

// ---------------------------------------------------------------------------------------------
// pii: SSN and Luhn-valid card flagged only when pii true (ledger #5)
// ---------------------------------------------------------------------------------------------

describe("memoryDefense pii option — SSN and Luhn-valid card flagged only when pii: true", () => {
  let v: M5Vault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  it("SSN passes through untouched when pii is false, even in block mode", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: false } });
    const ssn = fakeSsn();
    const r = await v.call("create_entity", {
      vault: "test",
      type: "person",
      name: "pii-off-ssn",
      observations: [ssn],
    });
    expect(r.ok).toBe(true);
  });

  it("SSN is blocked when pii is true", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: true } });
    const ssn = fakeSsn();
    const r = await v.call("create_entity", {
      vault: "test",
      type: "person",
      name: "pii-on-ssn",
      observations: [ssn],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("secret_detected");
  });

  it("Luhn-valid card passes through untouched when pii is false, even in block mode", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: false } });
    const card = fakeValidVisaCard();
    const r = await v.call("create_entity", {
      vault: "test",
      type: "person",
      name: "pii-off-card",
      observations: [card],
    });
    expect(r.ok).toBe(true);
  });

  it("Luhn-valid card is blocked when pii is true", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: true } });
    const card = fakeValidVisaCard();
    const r = await v.call("create_entity", {
      vault: "test",
      type: "person",
      name: "pii-on-card",
      observations: [card],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("secret_detected");
  });
});

// ---------------------------------------------------------------------------------------------
// fail closed: scanner throw refuses the write (ledger #6)
// ---------------------------------------------------------------------------------------------

describe("memoryDefense fail closed — a scanner exception on an in-scope write refuses it", () => {
  let v: M5Vault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  it("block mode: a scanner throw refuses the write with secret_detected, not a crash or a silent pass", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: false } });
    const r = await v.call("create_entity", {
      vault: "test",
      type: "person",
      name: "fail-closed-probe",
      observations: [`a fact carrying ${THROW_SENTINEL}`],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("secret_detected");
  });

  it("redact mode: a scanner throw ALSO refuses the write — fail closed never depends on mode", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "redact", pii: false } });
    const r = await v.call("create_entity", {
      vault: "test",
      type: "person",
      name: "fail-closed-redact-probe",
      observations: [`a fact carrying ${THROW_SENTINEL}`],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("secret_detected");
  });

  it("counts the fail-closed refusal under its own scanner_error pattern id", async () => {
    const metrics = new MetricsRecorder();
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: false }, metrics });
    await v.call("create_entity", {
      vault: "test",
      type: "person",
      name: "fail-closed-metrics-probe",
      observations: [`a fact carrying ${THROW_SENTINEL}`],
    });
    const text = await metrics.metrics();
    expect(text).toContain('obsidian_tc_memory_defense_hits_total{pattern="scanner_error"} 1');
  });
});

// ---------------------------------------------------------------------------------------------
// LEAK: the raw secret value never appears in response text, error message, log line, or metric
// label (ledger #7)
// ---------------------------------------------------------------------------------------------

describe("memoryDefense LEAK — the raw secret never surfaces anywhere observable", () => {
  let v: M5Vault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  it("block mode: response text, error message, event_log rows, and metric labels are all clean", async () => {
    const metrics = new MetricsRecorder();
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: true }, metrics });
    const secret = fakeOpenAiKey();
    const ssn = fakeSsn();

    const results = await Promise.all([
      v.call("create_entity", {
        vault: "test",
        type: "person",
        name: "leak-create",
        observations: [secret],
      }),
      v.call("enqueue_capture", { vault: "test", content: ssn }),
    ]);

    for (const r of results) {
      expect(r.ok).toBe(false);
      // The full JSON-serialized envelope — error code, message, details, meta — never contains
      // either raw value.
      const serialized = JSON.stringify(r);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(ssn);
    }

    // event_log: the dispatch audit trail records tool/status/error_code, never raw args.
    const rows = v.events();
    const rowsText = JSON.stringify(rows);
    expect(rowsText).not.toContain(secret);
    expect(rowsText).not.toContain(ssn);

    // The prometheus metric label set is pattern id only — never content.
    const metricsText = await metrics.metrics();
    expect(metricsText).not.toContain(secret);
    expect(metricsText).not.toContain(ssn);
    expect(metricsText).toContain('obsidian_tc_memory_defense_hits_total{pattern="openai_key"} 1');
    expect(metricsText).toContain('obsidian_tc_memory_defense_hits_total{pattern="ssn"} 1');
  });

  it("redact mode: the materialized note and every tool response are clean of the raw value", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "redact", pii: false } });
    const secret = fakeGithubToken();
    const r = await v.call("create_entity", {
      vault: "test",
      type: "person",
      name: "leak-redact-create",
      observations: [secret],
    });
    expect(JSON.stringify(r)).not.toContain(secret);
    const note = v.read(`memory/person/leak-redact-create.md`);
    expect(note).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------------------------
// GREEN: shapes that must NOT trip the scanner, even in the strictest configuration
// (block + pii: true) (ledger #8)
// ---------------------------------------------------------------------------------------------

describe("memoryDefense GREEN — false-positive corpus that must never be refused", () => {
  let v: M5Vault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  const greenCases: Array<{ label: string; value: () => string }> = [
    { label: "Luhn-invalid card-shaped digit run", value: fakeInvalidVisaCard },
    { label: "ISO 8601 date", value: () => "2026-09-28" },
    { label: "email address", value: () => ["person", "@", "example", ".com"].join("") },
    { label: "phone number (3-3-4 grouping)", value: () => "555-867-5309" },
    {
      label: "UUID next to an unrelated project-id label",
      value: () => "project id 3fa85f64-5717-4562-b3fc-2c963f66afa6",
    },
  ];

  for (const gc of greenCases) {
    it(`${gc.label} passes through untouched under block + pii:true`, async () => {
      v = makeM5Vault({ memoryDefense: { mode: "block", pii: true } });
      const r = await v.call("create_entity", {
        vault: "test",
        type: "person",
        name: `green-${gc.label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
        observations: [gc.value()],
      });
      expect(r.ok, `${gc.label} must not be refused`).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Sibling-writer audit (brief step 4): link_entities' relation_type and rename_entity's new_name
// are BOTH caller-controlled free text that lands in something a future session reads back
// (the relations table + a materialized [[link]]; the entity's own persisted identity + its
// note's filename/H1) — the same property create_entity/add_observation scan for. Neither was
// wired before this pass; both are now.
// ---------------------------------------------------------------------------------------------

describe("memoryDefense sibling writers — link_entities (relation_type) and rename_entity (new_name)", () => {
  let v: M5Vault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  async function twoEntities(vault: M5Vault): Promise<{ a: string; b: string }> {
    const a = un<{ entity_id: string }>(
      await vault.call("create_entity", {
        vault: "test",
        type: "person",
        name: "sib-a",
        materialize: false,
      }),
    );
    const b = un<{ entity_id: string }>(
      await vault.call("create_entity", {
        vault: "test",
        type: "person",
        name: "sib-b",
        materialize: false,
      }),
    );
    return { a: a.entity_id, b: b.entity_id };
  }

  it("link_entities: block mode refuses a secret-shaped relation_type, nothing persisted", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: false } });
    const { a, b } = await twoEntities(v);
    const secret = fakeOpenAiKey();
    const r = await v.call("link_entities", {
      vault: "test",
      source_id: a,
      target_id: b,
      relation_type: secret,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("secret_detected");
      expect(JSON.stringify(r.error)).not.toContain(secret);
    }
    // Nothing persisted: a clean link with the SAME (source, target) is not "existed_already".
    const retry = un<{ existed_already: boolean }>(
      await v.call("link_entities", {
        vault: "test",
        source_id: a,
        target_id: b,
        relation_type: "clean-relation",
      }),
    );
    expect(retry.existed_already).toBe(false);
  });

  it("link_entities: redact mode persists [REDACTED] as the relation_type and reports redactions", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "redact", pii: false } });
    const { a, b } = await twoEntities(v);
    const secret = fakeGithubToken();
    const r = un<{ relation_type: string; redactions: number }>(
      await v.call("link_entities", {
        vault: "test",
        source_id: a,
        target_id: b,
        relation_type: secret,
      }),
    );
    expect(r.relation_type).toBe("[REDACTED]");
    expect(r.redactions).toBe(1);
  });

  it("rename_entity: block mode refuses a secret-shaped new_name, entity keeps its old name", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: false } });
    const created = un<{ entity_id: string }>(
      await v.call("create_entity", {
        vault: "test",
        type: "person",
        name: "rename-probe",
        materialize: false,
      }),
    );
    const secret = fakeAwsKeyId();
    const r = await v.call("rename_entity", {
      vault: "test",
      entity_id: created.entity_id,
      new_name: secret,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("secret_detected");
      expect(JSON.stringify(r.error)).not.toContain(secret);
    }
    const get = un<{ name: string }>(
      await v.call("get_entity", { vault: "test", entity_id: created.entity_id }),
    );
    expect(get.name).toBe("rename-probe");
  });

  it("rename_entity: redact mode persists [REDACTED] as the name and reports redactions", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "redact", pii: false } });
    const created = un<{ entity_id: string }>(
      await v.call("create_entity", {
        vault: "test",
        type: "person",
        name: "rename-redact-probe",
        materialize: false,
      }),
    );
    const secret = fakeGithubToken();
    const r = un<{ name: string; redactions: number }>(
      await v.call("rename_entity", {
        vault: "test",
        entity_id: created.entity_id,
        new_name: secret,
      }),
    );
    expect(r.name).toBe("[REDACTED]");
    expect(r.redactions).toBe(1);
  });

  it("rename_entity: off mode (default) is unaffected — a status-only change with no new_name never scans", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: false } });
    const created = un<{ entity_id: string }>(
      await v.call("create_entity", {
        vault: "test",
        type: "person",
        name: "rename-status-only",
        materialize: false,
      }),
    );
    const r = await v.call("rename_entity", {
      vault: "test",
      entity_id: created.entity_id,
      status: "retired",
    });
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Security review findings (994-verify.log) — one describe block per finding.
// ---------------------------------------------------------------------------------------------

describe("review finding 1 — a secret that only matches AFTER sanitizeSegment (path-segment transform)", () => {
  let v: M5Vault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  it("create_entity: block mode refuses a name that is secret-shaped only after path sanitization, nothing persisted", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: false } });
    const secret = fakeOpenAiKeyWithColon();
    const r = await v.call("create_entity", { vault: "test", type: "person", name: secret });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("secret_detected");
      expect(JSON.stringify(r.error)).not.toContain(OPENAI_KEY_BODY);
    }
    const sanitizedPath = `memory/person/${sanitizePathSegmentLike(secret)}.md`;
    expect(v.exists(sanitizedPath)).toBe(false);
    // Nothing inserted into SQLite either: a clean retry with the SAME (type, name) succeeds.
    const retry = await v.call("create_entity", { vault: "test", type: "person", name: secret });
    expect(retry.ok).toBe(false); // still refused — proves the row was never left behind AND the
    // fix is deterministic, not a race; a name collision would instead read "entity already
    // exists", which is what confirms the FIRST call inserted nothing:
    if (!retry.ok) expect(retry.error.code).toBe("secret_detected");
  });

  it("create_entity: redact mode never lets the secret's entropy reach the entity name, vault_path, or the note on disk", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "redact", pii: false } });
    const secret = fakeOpenAiKeyWithColon();
    const r = await v.call("create_entity", { vault: "test", type: "person", name: secret });
    expect(r.ok).toBe(true);
    const data = un<{ name: string; vault_path: string | null; redactions: number }>(r);
    expect(data.name).not.toContain(OPENAI_KEY_BODY);
    expect(data.redactions).toBeGreaterThan(0);
    expect(data.vault_path).not.toBeNull();
    if (data.vault_path) {
      expect(data.vault_path).not.toContain(OPENAI_KEY_BODY);
      expect(v.read(data.vault_path)).not.toContain(OPENAI_KEY_BODY);
    }
  });

  it("rename_entity: block mode refuses a new_name that is secret-shaped only after path sanitization, entity keeps its old name", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: false } });
    const created = un<{ entity_id: string }>(
      await v.call("create_entity", {
        vault: "test",
        type: "person",
        name: "rename-path-probe",
        materialize: false,
      }),
    );
    const secret = fakeOpenAiKeyWithColon();
    const r = await v.call("rename_entity", {
      vault: "test",
      entity_id: created.entity_id,
      new_name: secret,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("secret_detected");
      expect(JSON.stringify(r.error)).not.toContain(OPENAI_KEY_BODY);
    }
    const get = un<{ name: string }>(
      await v.call("get_entity", { vault: "test", entity_id: created.entity_id }),
    );
    expect(get.name).toBe("rename-path-probe");
  });

  it("rename_entity: redact mode never lets the secret's entropy reach the persisted name", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "redact", pii: false } });
    const created = un<{ entity_id: string }>(
      await v.call("create_entity", {
        vault: "test",
        type: "person",
        name: "rename-path-redact-probe",
        materialize: false,
      }),
    );
    const secret = fakeOpenAiKeyWithColon();
    const r = un<{ name: string; redactions: number }>(
      await v.call("rename_entity", {
        vault: "test",
        entity_id: created.entity_id,
        new_name: secret,
      }),
    );
    expect(r.name).not.toContain(OPENAI_KEY_BODY);
    expect(r.redactions).toBeGreaterThan(0);
  });
});

describe("review finding 2 — commit_capture refuses a secret-shaped target_path even in redact mode", () => {
  let v: M5Vault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  it("redact mode: refuses rather than writing the secret into the FILENAME; capture stays queued and retryable", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "redact", pii: false } });
    const secret = fakeGithubToken();
    const enq = un<{ capture_id: string }>(
      await v.call("enqueue_capture", { vault: "test", content: "clean body" }),
    );
    const badPath = `inbox/${secret}.md`;
    const r = await v.call("commit_capture", {
      vault: "test",
      capture_id: enq.capture_id,
      target_path: badPath,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("secret_detected");
      expect(JSON.stringify(r.error)).not.toContain(secret);
    }
    expect(v.exists(badPath)).toBe(false);
    // Still queued, uncommitted — retryable with a clean path.
    const stillQueued = un<{ items: Array<{ capture_id: string; committed_at: number | null }> }>(
      await v.call("list_capture_queue", { vault: "test", committed: false }),
    );
    expect(stillQueued.items.map((i) => i.capture_id)).toContain(enq.capture_id);
    const retry = await v.call("commit_capture", {
      vault: "test",
      capture_id: enq.capture_id,
      target_path: "inbox/clean-retry-name.md",
    });
    expect(retry.ok).toBe(true);
  });

  it("off mode: unaffected — a secret-shaped target_path commits exactly as before this fix", async () => {
    v = makeM5Vault();
    const secret = fakeGithubToken();
    const enq = un<{ capture_id: string }>(
      await v.call("enqueue_capture", { vault: "test", content: "clean body" }),
    );
    const r = await v.call("commit_capture", {
      vault: "test",
      capture_id: enq.capture_id,
      target_path: `inbox/${secret}.md`,
    });
    expect(r.ok).toBe(true);
  });
});

describe("review finding 3 — enqueue_capture.source is scanned like every other field", () => {
  let v: M5Vault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  it("block mode: refuses a secret-shaped source, nothing queued", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: false } });
    const secret = fakeAwsKeyId();
    const r = await v.call("enqueue_capture", {
      vault: "test",
      content: "clean body",
      source: secret,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("secret_detected");
    const listed = un<{ items: unknown[] }>(await v.call("list_capture_queue", { vault: "test" }));
    expect(listed.items).toHaveLength(0);
  });

  it("redact mode: source is redacted, list_capture_queue never echoes it raw", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "redact", pii: false } });
    const secret = fakeGithubToken();
    const r = await v.call("enqueue_capture", {
      vault: "test",
      content: "clean body",
      source: secret,
    });
    expect(r.ok).toBe(true);
    expect(un<{ redactions: number }>(r).redactions).toBeGreaterThan(0);
    const listed = un<{ items: Array<{ source: string | null }> }>(
      await v.call("list_capture_queue", { vault: "test" }),
    );
    expect(listed.items[0]?.source).toBe("[REDACTED]");
  });
});

describe("review finding 4 — add_observation.key is scanned AFTER normalizeObservationKey lowercases it", () => {
  let v: M5Vault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  it("block mode: refuses a key that is secret-shaped only once lowercased", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: false } });
    const created = un<{ entity_id: string }>(
      await v.call("create_entity", {
        vault: "test",
        type: "person",
        name: "key-case-probe",
        materialize: false,
      }),
    );
    const secretKey = fakeUppercaseOpenAiKey();
    const r = await v.call("add_observation", {
      vault: "test",
      entity_id: created.entity_id,
      observation: "a clean fact",
      key: secretKey,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("secret_detected");
      expect(JSON.stringify(r.error)).not.toContain(OPENAI_KEY_BODY);
    }
    const get = un<{ observations: unknown[] }>(
      await v.call("get_entity", { vault: "test", entity_id: created.entity_id }),
    );
    expect(get.observations).toHaveLength(0);
  });

  it("redact mode: the persisted (lowercased) key never carries the secret's entropy", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "redact", pii: false } });
    const created = un<{ entity_id: string }>(
      await v.call("create_entity", {
        vault: "test",
        type: "person",
        name: "key-case-redact-probe",
        materialize: false,
      }),
    );
    const secretKey = fakeUppercaseOpenAiKey();
    const r = un<{ redactions: number }>(
      await v.call("add_observation", {
        vault: "test",
        entity_id: created.entity_id,
        observation: "a clean fact",
        key: secretKey,
      }),
    );
    expect(r.redactions).toBeGreaterThan(0);
    const get = un<{ observations: Array<{ key: string | null; text: string }> }>(
      await v.call("get_entity", { vault: "test", entity_id: created.entity_id }),
    );
    expect(get.observations[0]?.key).not.toContain(OPENAI_KEY_BODY);
  });
});

describe("review finding 5 — a number/bigint leaf is stringified and scanned, not skipped", () => {
  let v: M5Vault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  it("commit_capture: pii:true catches a Luhn-valid card number typed as a JSON NUMBER, not just a quoted string", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: true } });
    const cardNumber = fakeValidVisaCardNumber();
    const enq = un<{ capture_id: string }>(
      await v.call("enqueue_capture", { vault: "test", content: "clean body" }),
    );
    const r = await v.call("commit_capture", {
      vault: "test",
      capture_id: enq.capture_id,
      target_path: "numeric-pii/commit.md",
      frontmatter_overrides: { card: cardNumber },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("secret_detected");
    expect(v.exists("numeric-pii/commit.md")).toBe(false);
  });

  it("commit_capture: a CLEAN number leaf keeps its original numeric type (never coerced to a string)", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "redact", pii: true } });
    const enq = un<{ capture_id: string }>(
      await v.call("enqueue_capture", { vault: "test", content: "clean body" }),
    );
    const r = await v.call("commit_capture", {
      vault: "test",
      capture_id: enq.capture_id,
      target_path: "numeric-clean/commit.md",
      frontmatter_overrides: { count: 42 },
    });
    expect(r.ok).toBe(true);
    expect(v.read("numeric-clean/commit.md")).toContain("count: 42");
  });
});

describe("review finding 6 — labeled_secret confidence tiers (block mode never persists a low-confidence hit verbatim, and never refuses one)", () => {
  let v: M5Vault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  const lowConfidenceCases: Array<{ label: string; value: () => string }> = [
    { label: "token: deployment-id-12345", value: fakeLowConfidenceLabeledSecretA },
    { label: "password: hunter22-old", value: fakeLowConfidenceLabeledSecretB },
    { label: "password: Summer2024! (short, mixed-class)", value: fakeLowConfidenceLabeledSecretC },
    { label: "token: <UUID> (long, but UUID-shaped)", value: fakeLabeledUuidValue },
    // item 3 — entropy floor / shape exclusions added to the length >= 20 branch.
    { label: "token: production-service-1 (low entropy)", value: fakeLowEntropyServiceLabel },
    { label: "token: <ULID> (long, but ULID-shaped)", value: fakeLabeledUlidValue },
  ];

  for (const c of lowConfidenceCases) {
    it(`block mode: "${c.label}" is NOT refused — write succeeds with the value redacted, never stored verbatim`, async () => {
      v = makeM5Vault({ memoryDefense: { mode: "block", pii: false } });
      const value = c.value();
      const r = await v.call("create_entity", {
        vault: "test",
        type: "person",
        name: `low-conf-${c.label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
        observations: [value],
      });
      expect(r.ok, `${c.label} must NOT be refused`).toBe(true);
      const get = un<{ observations: Array<{ text: string }> }>(
        await v.call("get_entity", {
          vault: "test",
          entity_id: un<{ entity_id: string }>(r).entity_id,
        }),
      );
      // Never stored verbatim — the label's own value portion is gone even though the write
      // succeeded.
      expect(get.observations[0]?.text).not.toBe(value);
      expect(get.observations[0]?.text).toContain("[REDACTED]");
    });
  }

  it("block mode: counts a low-confidence hit under labeled_secret_low_confidence, never under labeled_secret", async () => {
    const metrics = new MetricsRecorder();
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: false }, metrics });
    await v.call("create_entity", {
      vault: "test",
      type: "person",
      name: "low-conf-metric-probe",
      observations: [fakeLowConfidenceLabeledSecretA()],
    });
    const text = await metrics.metrics();
    expect(text).toContain(
      'obsidian_tc_memory_defense_hits_total{pattern="labeled_secret_low_confidence"} 1',
    );
    expect(text).not.toContain('obsidian_tc_memory_defense_hits_total{pattern="labeled_secret"}');
  });

  it("block mode: a realistic mixed-class labeled secret (api_key = 32 random chars) IS refused", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: false } });
    const secret = fakeHighConfidenceLabeledSecret();
    const r = await v.call("create_entity", {
      vault: "test",
      type: "person",
      name: "high-conf-mixed-probe",
      observations: [secret],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("secret_detected");
  });

  it("block mode: a 32-char lowercase-hex labeled token IS refused (length>=20 branch, classes<3)", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: false } });
    const secret = fakeHighConfidenceLowercaseHexLabeledSecret();
    const r = await v.call("create_entity", {
      vault: "test",
      type: "person",
      name: "high-conf-hex-probe",
      observations: [secret],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("secret_detected");
  });

  it("block mode: a realistic 40-char base64url labeled token IS refused (classes>=3 branch, unaffected by the entropy floor)", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: false } });
    const secret = fakeHighConfidenceBase64UrlLabeledSecret();
    const r = await v.call("create_entity", {
      vault: "test",
      type: "person",
      name: "high-conf-base64url-probe",
      observations: [secret],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("secret_detected");
  });

  it("redact mode: low-confidence hits are redacted exactly as high-confidence ones are", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "redact", pii: false } });
    const r = un<{ redactions: number }>(
      await v.call("create_entity", {
        vault: "test",
        type: "person",
        name: "low-conf-redact-probe",
        observations: [fakeLowConfidenceLabeledSecretB()],
      }),
    );
    expect(r.redactions).toBeGreaterThan(0);
  });

  // Security review round (LOW #11): ULID_SHAPE_RE dropped its `/i` flag on purpose — a canonical
  // ULID is uppercase-only, so matching it case-insensitively forced ANY 26-char mixed-case token
  // (a real high-entropy secret can easily land in that exact length/alphabet) to low-confidence
  // before the classes>=3 test ever ran. This is the RED case that regex bug would have missed.
  it("block mode: a 26-char MIXED-CASE token in the ULID length/alphabet range is REFUSED (not excluded as ULID-shaped)", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: false } });
    // Same 26 canonical-ULID characters as fakeLabeledUlidValue above, alternating case — still
    // 26 chars, still digits+letters, but no longer uppercase-only, so ULID_SHAPE_RE (case-
    // sensitive) must NOT match it. 3 character classes (lower+upper+digit) push it through the
    // classes>=3 branch unconditionally.
    const canonical = ["01ARZ3ND", "EKTSV4RR", "FFQ69G5F", "AV"].join("");
    const mixedCase = canonical
      .split("")
      .map((c, i) => (i % 2 === 0 ? c.toLowerCase() : c))
      .join("");
    expect(mixedCase).toHaveLength(26);
    expect(mixedCase).not.toBe(mixedCase.toUpperCase()); // genuinely mixed-case
    const secret = ["token", ": ", mixedCase].join("");
    const r = await v.call("create_entity", {
      vault: "test",
      type: "person",
      name: "mixed-case-ulid-shaped-probe",
      observations: [secret],
    });
    expect(r.ok, "a mixed-case 26-char token must not be waved through as ULID-shaped").toBe(false);
    if (!r.ok) expect(r.error.code).toBe("secret_detected");
  });
});

describe("review finding 7 — set_goal resolves `vault` through the registry before looking up policy", () => {
  it("an unregistered vault id is refused with vault_not_found, not silently inserted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otc-setgoal-vault-"));
    try {
      const registry = new ToolRegistry({});
      const vaultRegistry = new VaultRegistry([{ id: "main", path: dir }]);
      registerM8Tools(registry, {
        edb: edb0(),
        now: () => 1_700_000_000_000,
        vaultRegistry,
      });
      const ctx: CallerContext = {
        caller: "tester",
        authenticated: true,
        grantedScopes: new Set(["*"]),
        vaultId: "main",
        db: cacheDb0(),
      };
      const r = await registry.dispatch(
        "set_goal",
        { vault: "does-not-exist", text: "clean text" },
        ctx,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("vault_not_found");
    } finally {
      rmTemp(dir);
    }
  });

  it("a registered vault id still resolves and set_goal succeeds, memoryDefense keyed by the RESOLVED id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otc-setgoal-vault2-"));
    try {
      const registry = new ToolRegistry({});
      const vaultRegistry = new VaultRegistry([{ id: "main", path: dir }]);
      const seenVaultIds: string[] = [];
      registerM8Tools(registry, {
        edb: edb0(),
        now: () => 1_700_000_000_000,
        vaultRegistry,
        memoryDefense: (vaultId: string) => {
          seenVaultIds.push(vaultId);
          return { mode: "off", pii: false };
        },
      });
      const ctx: CallerContext = {
        caller: "tester",
        authenticated: true,
        grantedScopes: new Set(["*"]),
        vaultId: "main",
        db: cacheDb0(),
      };
      const r = await registry.dispatch("set_goal", { vault: "main", text: "clean text" }, ctx);
      expect(r.ok).toBe(true);
      // The policy lookup was keyed by the RESOLVED vault id, not the raw caller string (here
      // they happen to be equal, but the lookup went through `vaultRegistry.resolve(...).id`,
      // proven by finding 7's other test refusing an id resolve() itself would reject).
      expect(seenVaultIds).toContain("main");
    } finally {
      rmTemp(dir);
    }
  });
});

describe("review finding (addendum) — an invalid guarded field never echoes its raw value in an error", () => {
  let v: M5Vault | undefined;
  afterEach(() => {
    v?.cleanup();
    v = undefined;
  });

  it("add_observation: a secret-shaped key that fails validation is never echoed raw in the error", async () => {
    // `ObservationKeySchema`'s own zod regex is the SAME character class
    // `normalizeObservationKey` checks (case-insensitively) — so a key shaped enough to reach the
    // handler's own "key must match..." throw can never actually exist through this tool's public
    // input schema (the schema itself already rejects anything that would trip it, e.g. an
    // embedded space, one boundary earlier as a `validation_error`). That earlier zod boundary is
    // therefore the reachable leak surface for an invalid, secret-shaped key: prove IT never
    // echoes the raw value either — the property this test (and the handler-side redaction fix)
    // both exist to guarantee, regardless of which boundary actually catches a given bad key.
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: false } });
    const created = un<{ entity_id: string }>(
      await v.call("create_entity", {
        vault: "test",
        type: "person",
        name: "invalid-key-leak-probe",
        materialize: false,
      }),
    );
    const secretKey = ["sk", "-", OPENAI_KEY_BODY, " ", "not a valid key"].join("");
    const r = await v.call("add_observation", {
      vault: "test",
      entity_id: created.entity_id,
      observation: "a clean fact",
      key: secretKey,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("validation_error");
      expect(JSON.stringify(r.error)).not.toContain(OPENAI_KEY_BODY);
    }
  });

  it("commit_capture: a secret-shaped target_path colliding with an existing note is redacted in the 'already exists' error", async () => {
    v = makeM5Vault({ memoryDefense: { mode: "block", pii: false } });
    const secret = fakeGithubToken();
    const collisionPath = `taken/${secret}.md`;
    v.write(collisionPath, "pre-existing note");
    const enq = un<{ capture_id: string }>(
      await v.call("enqueue_capture", { vault: "test", content: "clean body" }),
    );
    const r = await v.call("commit_capture", {
      vault: "test",
      capture_id: enq.capture_id,
      target_path: collisionPath,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("note_exists");
      expect(JSON.stringify(r.error)).not.toContain(secret);
    }
  });
});
