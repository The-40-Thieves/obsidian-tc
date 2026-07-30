// THE-228 — agent_episodes capture bus. Proves the sink appends one row per dispatch outcome
// with attribution + write-on-control defaults (eligibility 'pending', blocked 0), chains
// prev_id per caller, gates the content axis behind captureContent (with secret redaction +
// size cap), never throws, and fires end-to-end from a real ToolRegistry dispatch via the
// onEpisode hook.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { createEpisodeCapture, redactSecrets } from "../src/experiential/episodes";
import { type CallerContext, type DispatchEpisode, ToolRegistry } from "../src/mcp/registry";
import { openMemoryDb } from "./helpers";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
const EXP_CHAIN = [
  { version: "20260626_001", sql: read("20260626_001_experiential_init.sql") },
  { version: "20260711_001", sql: read("20260711_001_experiential_outcome.sql") },
  { version: "20260711_002", sql: read("20260711_002_agent_episodes.sql") },
];
const NOW = 1_700_000_000_000;

function edb0(): Database {
  const db = openMemoryDb();
  runMigrations(db, EXP_CHAIN);
  return db;
}

function ev(over: Partial<DispatchEpisode> = {}): DispatchEpisode {
  return {
    ts: NOW,
    vaultId: "main",
    tool: "read_note",
    caller: "tester",
    sessionId: null,
    status: "ok",
    errorCode: null,
    durationMs: 12,
    resultSize: 340,
    argsHash: "h1",
    args: { path: "a.md" },
    ...over,
  };
}

interface Row {
  id: string;
  ts: number;
  vault_id: string;
  session_id: string | null;
  caller: string | null;
  channel: string;
  episode_type: string;
  tool: string;
  status: string;
  error_code: string | null;
  args_json: string | null;
  secret_scan: string;
  eligibility: string;
  blocked: number;
  valid_from: number;
  prev_id: string | null;
}

const allRows = (db: Database) =>
  db.prepare("SELECT * FROM agent_episodes ORDER BY ts, id").all() as Row[];

describe("agent_episodes capture bus (THE-228)", () => {
  it("appends one row per outcome with control defaults; content axis off by default", () => {
    const db = edb0();
    let t = NOW;
    const sink = createEpisodeCapture(db, { now: () => t++ });
    sink(ev());
    sink(ev({ status: "error", errorCode: "forbidden", tool: "delete_note" }));
    const rows = allRows(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      vault_id: "main",
      session_id: null,
      caller: "tester",
      channel: "dispatch",
      episode_type: "tool_call",
      tool: "read_note",
      status: "ok",
      error_code: null,
      args_json: null, // content axis defaults OFF (THE-238 gate ordering)
      secret_scan: "off",
      eligibility: "pending", // control 2: born pending, evaluator stamps later
      blocked: 0, // control 1: tombstone off
      valid_from: NOW, // control 3: bi-temporal birth (first event's clock tick)
    });
    const err = rows.find((r) => r.status === "error");
    expect(err?.error_code).toBe("forbidden");
    expect(err?.tool).toBe("delete_note");
  });

  it("chains prev_id per caller", () => {
    const db = edb0();
    let t = NOW;
    const sink = createEpisodeCapture(db, { now: () => t++ });
    sink(ev({ caller: "a", argsHash: "1" }));
    sink(ev({ caller: "b", argsHash: "2" }));
    sink(ev({ caller: "a", argsHash: "3" }));
    const rows = allRows(db);
    const a = rows.filter((r) => r.caller === "a");
    const b = rows.filter((r) => r.caller === "b");
    expect(a[0]?.prev_id).toBeNull();
    expect(a[1]?.prev_id).toBe(a[0]?.id); // second "a" episode chains to the first
    expect(b[0]?.prev_id).toBeNull(); // other caller's chain is independent
  });

  it("THE-654: the chain survives a restart — a fresh sink still finds the caller's last episode", () => {
    const db = edb0();
    let t = NOW;
    // First "process": one sink instance, one episode for "a".
    const first = createEpisodeCapture(db, { now: () => t++ });
    first(ev({ caller: "a", argsHash: "1" }));
    const firstId = allRows(db)[0]?.id;
    expect(firstId).toBeDefined();

    // Restart: a BRAND NEW createEpisodeCapture call, exactly what boot does — its prevByCaller
    // Map starts empty. Without a durable fallback this reads as "a" has no previous episode and
    // breaks the amendment chain (THE-655 walks prev_id) at every process restart.
    const restarted = createEpisodeCapture(db, { now: () => t++ });
    restarted(ev({ caller: "a", argsHash: "2" }));
    const rows = allRows(db).filter((r) => r.caller === "a");
    expect(rows).toHaveLength(2);
    expect(rows[1]?.prev_id).toBe(firstId); // chains across the restart, not null

    // A caller truly seen for the first time ever (by any process) still gets prev_id null.
    restarted(ev({ caller: "never-before", argsHash: "3" }));
    const fresh = allRows(db).find((r) => r.caller === "never-before");
    expect(fresh?.prev_id).toBeNull();

    // The in-memory cache still short-circuits within the SAME process — no extra chain break.
    restarted(ev({ caller: "a", argsHash: "4" }));
    const aChain = allRows(db).filter((r) => r.caller === "a");
    expect(aChain[2]?.prev_id).toBe(aChain[1]?.id);
  });

  it("THE-654: a null caller's chain is looked up as NULL, not the string 'null'", () => {
    const db = edb0();
    let t = NOW;
    const first = createEpisodeCapture(db, { now: () => t++ });
    first(ev({ caller: null, argsHash: "1" }));
    const firstId = allRows(db)[0]?.id;

    const restarted = createEpisodeCapture(db, { now: () => t++ });
    restarted(ev({ caller: null, argsHash: "2" }));
    const rows = allRows(db).filter((r) => r.caller === null);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.prev_id).toBe(firstId);
  });

  it("captureContent persists redacted, size-capped args and records the scan", () => {
    const db = edb0();
    const sink = createEpisodeCapture(db, { now: () => NOW, captureContent: true });
    sink(
      ev({
        args: {
          note: "call with api_key=supersecret12345 and sk-abcdefghijklmnopqrstuvwx please",
        },
      }),
    );
    const [row] = allRows(db);
    expect(row?.secret_scan).toBe("redacted:2");
    expect(row?.args_json).toContain("[REDACTED]");
    expect(row?.args_json).not.toContain("supersecret12345");
    expect(row?.args_json).not.toContain("sk-abcdefghijklmnopqrstuvwx");

    const sinkCapped = createEpisodeCapture(db, {
      now: () => NOW + 1,
      captureContent: true,
      maxArgsBytes: 64,
    });
    sinkCapped(ev({ args: { blob: "y".repeat(500) }, argsHash: "big" }));
    const capped = allRows(db).find((r) => r.ts === NOW + 1);
    expect(capped?.args_json?.endsWith("…[truncated]")).toBe(true);
    expect((capped?.args_json ?? "").length).toBeLessThan(100);
  });

  it("THE-619 item 4: redaction scans the FULL raw text before the maxArgsBytes cap — a secret positioned past the cap is still fully redacted, never leaked as a partial fragment", () => {
    // Ordering check, not a bug fix: createEpisodeCapture calls redactSecrets(raw) on the
    // complete, untruncated JSON BEFORE slicing to maxArgsBytes (episodes.ts, the
    // `if (opts.captureContent === true)` block). Had truncation run first, a secret sitting
    // past the byte cap would never see the pattern match — and a secret straddling the cap
    // could leak a partial, unmatched fragment in cleartext. Prove the opposite end-to-end.
    const db = edb0();
    const secret = "AKIAABCDEFGHIJKLMNOP"; // AKIA + 16 chars: matches the AWS-key pattern exactly
    const sink = createEpisodeCapture(db, {
      now: () => NOW,
      captureContent: true,
      maxArgsBytes: 20, // far smaller than the payload, so the secret sits well past the cap
    });
    // A space (not another word char) precedes the secret so the pattern's `\b` word-boundary
    // anchor actually fires — this test is about ordering, not about the boundary anchor itself.
    sink(ev({ args: { blob: `${"x".repeat(29)} ${secret}` } }));
    const [row] = allRows(db);
    expect(row?.args_json).not.toContain(secret);
    expect(row?.args_json).not.toContain("AKIA"); // no partial-token fragment survives either
    expect(row?.secret_scan).toBe("redacted:1");
  });

  it("clean content records scan 'clean'", () => {
    const db = edb0();
    const sink = createEpisodeCapture(db, { now: () => NOW, captureContent: true });
    sink(ev({ args: { path: "notes/plain.md" } }));
    const [row] = allRows(db);
    expect(row?.secret_scan).toBe("clean");
    expect(row?.args_json).toContain("notes/plain.md");
  });

  it("never throws: a broken store reports to onError and the caller survives", () => {
    const db = edb0();
    db.exec("DROP TABLE agent_episodes");
    let seen: unknown;
    let sink: ReturnType<typeof createEpisodeCapture> = () => {};
    try {
      sink = createEpisodeCapture(db, {
        now: () => NOW,
        onError: (e) => {
          seen = e;
        },
      });
    } catch (e) {
      seen = e;
    }
    expect(() => sink(ev())).not.toThrow();
    expect(seen).toBeDefined();
  });

  it("redactSecrets catches the credential shapes and counts hits", () => {
    const { text, redactions } = redactSecrets(
      [
        "token=abcdef123456789",
        "Bearer aaaaaaaaaaaaaaaaaaaa",
        "ghp_ABCDEFGHIJKLMNOPQRSTUV",
        "AKIAABCDEFGHIJKLMNOP",
        "nothing secret here",
      ].join(" "),
    );
    expect(redactions).toBe(4);
    expect(text).toContain("nothing secret here");
    expect(text).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUV");
  });

  // THE-619 item 3: SECRET_PATTERNS was missing two categories, verified empirically (not
  // assumed) by running redactSecrets against each candidate shape before writing any pattern.
  // Confirmed already covered and left alone: generic PEM private keys (RSA/EC/DSA/OPENSSH —
  // the existing `-----BEGIN [A-Z ]*PRIVATE KEY-----` pattern matches any of those banners).
  // Genuinely missing: DB/service connection strings with embedded credentials, and bare
  // (unlabeled) provider API keys — the existing generic `api_key=`/`token:`-style catch-all
  // only fires when a recognized label word precedes the value, so a key pasted bare (as it
  // usually is: in a connection string, a URL query param, a config value with no label) slips
  // through untouched. Fixtures below are deliberately synthetic (repeated filler / "DUMMY" /
  // "FAKE" markers, not random-looking) — this repo is public and runs gitleaks + verified-only
  // trufflehog in CI (`packages/server/test/.*` is gitleaks-allowlisted regardless, but the
  // synthetic shape also keeps trufflehog's verification step a guaranteed no-op).
  describe("SECRET_PATTERNS additions (THE-619 item 3)", () => {
    it("catches a DB connection string with embedded credentials", () => {
      const { text, redactions } = redactSecrets(
        "conn: postgres://demo_user:demoPass123@db.example.internal:5432/appdb",
      );
      expect(redactions).toBeGreaterThan(0);
      expect(text).not.toContain("demo_user:demoPass123");
    });

    it("near-miss: a connection string with NO embedded credentials is not flagged", () => {
      const { text, redactions } = redactSecrets("conn: postgres://db.example.internal:5432/appdb");
      expect(redactions).toBe(0);
      expect(text).toContain("postgres://db.example.internal:5432/appdb");
    });

    it("catches a Google-API-key-shaped bare token (no label preceding it)", () => {
      const fakeKey = `AIza${"D".repeat(35)}`; // synthetic filler, correct-length shape only
      const { text, redactions } = redactSecrets(`ref ${fakeKey} in the config`);
      expect(redactions).toBeGreaterThan(0);
      expect(text).not.toContain(fakeKey);
    });

    it("near-miss: an AIza-prefixed string one character short of the real length is not flagged", () => {
      const notAKey = `AIza${"D".repeat(34)}`;
      const { text, redactions } = redactSecrets(`ref ${notAKey} in the config`);
      expect(redactions).toBe(0);
      expect(text).toContain(notAKey);
    });

    it("catches a Stripe-shaped bare secret key", () => {
      // `sk_test_`, not `sk_live_`: the pattern accepts either (`(?:live|test)`), so a TEST-mode
      // key exercises it just as well while not being a live-credential shape at all. A literal
      // `sk_live_` fixture is what GitHub push protection's Stripe scanner matches on, and the
      // fix for that is to stop writing a live-key shape — never to obfuscate one past the
      // scanner. Kept as a plain literal, matching every other fixture in this file.
      const fakeSecret = "sk_test_51HDUMMYFAKEKEYFORTESTONLY000000";
      const { text, redactions } = redactSecrets(fakeSecret);
      expect(redactions).toBeGreaterThan(0);
      expect(text).not.toContain(fakeSecret);
    });

    it("near-miss: a Stripe PUBLISHABLE key (pk_) is not flagged — it is not a secret", () => {
      const publishable = "pk_test_51HDUMMYFAKEKEYFORTESTONLY000000";
      const { text, redactions } = redactSecrets(publishable);
      expect(redactions).toBe(0);
      expect(text).toContain(publishable);
    });

    it("catches a Hugging Face token (bare, no preceding label)", () => {
      // No "token:"/"api_key="-style label in front — this exercises the hf_-specific pattern
      // in isolation, not the generic labeled-value catch-all above. THE-619 defect 4: this
      // fixture used to be 33 chars while claiming a "correct length" token — that codified the
      // pattern's permissive `{30,}` floor as if it were the real shape. Use a GENUINE 34-char
      // payload (the shape upstream Gitleaks models: `hf_` + exactly 34 alphanumeric) so this
      // test asserts against the real token length, not just "long enough to pass the floor".
      const fakeToken = `hf_${"D".repeat(34)}`; // synthetic filler, genuine 34-char hf_ token shape
      const { text, redactions } = redactSecrets(`ref ${fakeToken} in the config`);
      expect(redactions).toBeGreaterThan(0);
      expect(text).not.toContain(fakeToken);
    });

    it("THE-619 defect 3: an hf_ token immediately followed by `_` is still caught", () => {
      // The old pattern's trailing `\b` never fires between two word characters, and `_` is a
      // word character — so a token flush against a trailing underscore slipped through with 0
      // redactions. This is the false-negative / leak defect, not a cosmetic near-miss. No
      // preceding label word (as in the "bare" test above) — isolates the hf_-specific pattern
      // from the generic labeled-value catch-all, which would otherwise mask the bug via a
      // "token=" style label.
      const secretPart = "a".repeat(36);
      const fakeToken = `hf_${secretPart}_`;
      const { text, redactions } = redactSecrets(`ref ${fakeToken} in the config`);
      expect(redactions).toBeGreaterThan(0);
      expect(text).not.toContain(secretPart);
    });

    it("THE-619 defect 3: an hf_ token wrapped in markdown emphasis (_..._) is still caught", () => {
      // A realistic capture-path shape: someone pastes a token into markdown and it lands
      // wrapped in emphasis underscores on both sides. Both the leading AND trailing `_`
      // defeated the old \b-anchored pattern.
      const secretPart = "b".repeat(36);
      const wrapped = `_hf_${secretPart}_`;
      const { text, redactions } = redactSecrets(`note: ${wrapped} here`);
      expect(redactions).toBeGreaterThan(0);
      expect(text).not.toContain(secretPart);
    });

    it("near-miss: a bare content hash is not flagged as a Hugging Face token", () => {
      // A hex sha (git commit / content hash) can never contain the literal `hf_` prefix — hex
      // digits stop at 'f', so 'h' never appears — but this pins that guarantee against future
      // pattern changes rather than trusting it implicitly.
      const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85";
      const { text, redactions } = redactSecrets(`content hash: ${sha}`);
      expect(redactions).toBe(0);
      expect(text).toContain(sha);
    });

    // THE-619 defect 1/2: `sig` sitting in the generic keyword alternation over-redacted benign
    // config values (`sig: migration`, `sig=disabled`) and public, non-secret signature material.
    // Replaced with a standalone pattern requiring actual query-parameter context (`?`/`&`, or
    // their percent-encoded forms) plus a realistic Base64-signature length floor. Fixture
    // signatures below are 44 chars — the real Base64-encoded HMAC-SHA256 shape (32 bytes -> 44
    // chars incl. one `=` pad) — matching the pattern's documented floor rather than an
    // arbitrarily short placeholder.
    const SAS_SIG = "A1b2C3d4E5A1b2C3d4E5A1b2C3d4E5A1b2C3d4E5Hi9K"; // 44 chars, genuine SAS-sig shape

    it("THE-619 defect 1: a literal Azure SAS URL is still redacted by the targeted pattern", () => {
      const sasUrl = `https://demoaccount.blob.core.windows.net/democontainer/blob.txt?sv=2022-11-02&ss=b&srt=sco&sp=rwdlacx&se=2026-08-01T00:00:00Z&sig=${SAS_SIG}`;
      const { text, redactions } = redactSecrets(sasUrl);
      expect(redactions).toBeGreaterThan(0);
      expect(text).not.toContain(SAS_SIG);
    });

    it("THE-619 defect 2: a percent-encoded (URL-encoded) SAS URL is redacted too", () => {
      // Realistic on a capture path: this exact shape (the whole URL, including its own `?`/`&`/
      // `=` delimiters, percent-encoded) appears when a SAS URL is carried as a JSON string
      // argument. The old pattern only recognized literal `?`/`&`/`sig=` and missed this
      // entirely (0 redactions) — the encoded delimiters (`%3F`/`%26`/`%3D`) need their own path.
      const encoded = `https%3A%2F%2Fx.blob.core.windows.net%2Fc%3Fsv%3D2022-11-02%26sig%3D${SAS_SIG}`;
      const { text, redactions } = redactSecrets(encoded);
      expect(redactions).toBeGreaterThan(0);
      expect(text).not.toContain(SAS_SIG);
    });

    it("THE-619 defect 1: benign 'sig' labeled values are NOT redacted", () => {
      for (const benign of ["sig: migration", "sig=disabled", "sig: v2"]) {
        const { text, redactions } = redactSecrets(benign);
        expect(redactions).toBe(0);
        expect(text).toBe(benign);
      }
    });

    it("THE-619 defect 1: public signature material (not a secret) is NOT redacted", () => {
      const benign = "sig: MEUCIQDxyzABCDEFGHIJKLMNOP";
      const { text, redactions } = redactSecrets(benign);
      expect(redactions).toBe(0);
      expect(text).toBe(benign);
    });

    it("near-miss: 'signature' (containing 'sig' as a substring) and a bare hash are not flagged", () => {
      // This near-miss stays green whether or not `sig` sits in the generic alternation: even
      // before THE-619 defect 1's fix, "signature" was never followed immediately by `=`/`:` (it
      // is followed by "nature"), so the keyword match never fired on it either way.
      const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85";
      const { text, redactions } = redactSecrets(`commit signature check: ${sha}`);
      expect(redactions).toBe(0);
      expect(text).toContain(sha);
    });
  });

  it("fires end-to-end from a real dispatch via the registry onEpisode hook", async () => {
    // cache.db side: the audit event_log the dispatch pipeline writes to.
    const cacheDb = openMemoryDb();
    runMigrations(cacheDb, [
      {
        version: "001",
        sql: "CREATE TABLE event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, vault_id TEXT, tool_name TEXT, caller TEXT, duration_ms INTEGER, result_size INTEGER, status TEXT NOT NULL, error_code TEXT, args_hash TEXT, event_type TEXT);",
      },
    ]);
    const edb = edb0();
    const registry = new ToolRegistry({
      onEpisode: createEpisodeCapture(edb, { now: () => NOW }),
    });
    registry.register({
      name: "read_thing",
      description: "scoped read",
      inputSchema: z.object({ path: z.string() }),
      requiredScopes: ["read:notes"],
      handler: (i: { path: string }) => ({ path: i.path, ok: true }),
    });
    const ctx: CallerContext = {
      caller: "tester",
      authenticated: true,
      grantedScopes: new Set(["read:notes"]),
      vaultId: "main",
      db: cacheDb,
      sessionId: "sess_abc",
    };
    const res = await registry.dispatch("read_thing", { path: "a.md" }, ctx);
    expect((res as { ok?: boolean }).ok ?? true).toBeTruthy();
    const rows = allRows(edb);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: "read_thing",
      caller: "tester",
      session_id: "sess_abc",
      status: "ok",
      channel: "dispatch",
      eligibility: "pending",
    });
    expect(rows[0]?.args_json).toBeNull(); // content axis off by default
  });
});
