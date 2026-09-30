// write_attachment overwrite: trash + write is two steps. The effect must be marked committed only
// once it is NOT undone — after a successful write, or when the rollback itself could not restore.
// It used to be marked BEFORE the write, so a failed write whose rollback fully restored the prior
// bytes still turned the retry into indeterminate_outcome.
import * as fs from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { makeM3Vault } from "./m3-helpers";
import { rmTemp } from "./tmp";
import { trySymlink } from "./write-io-backends";

// Fault injection for the write step of write_attachment: a queue of behaviours consumed per call.
const writeFault: { next: Array<"fail" | "fail-and-occupy" | "pass"> } = { next: [] };
vi.mock("../src/vault/notes-io", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault/notes-io")>();
  return {
    ...actual,
    writeFileAtomic: (
      abs: string,
      data: Buffer,
      createDirs?: boolean,
      opts?: { exclusive?: boolean },
    ) => {
      const mode = writeFault.next.shift() ?? "pass";
      if (mode === "fail") throw new Error("disk full (injected)");
      if (mode === "fail-and-occupy") {
        // The path is re-created by someone else mid-failure, so the no-replace restore cannot land.
        writeFileSync(abs, "SOMEONE ELSE");
        throw new Error("disk full (injected)");
      }
      return actual.writeFileAtomic(abs, data, createDirs, opts);
    },
  };
});

/** Two-step HITL: the first dispatch answers elicit_required with the args hash; mint a token for
 *  exactly that hash (the tool input alone does not reproduce it once defaults and the nested
 *  idempotency key are folded in) and dispatch again. */
async function confirmed(v: ReturnType<typeof makeM3Vault>, input: Record<string, unknown>) {
  const first = await v.call("write_attachment", input);
  if (first.ok || first.error.code !== "elicit_required") return first;
  const hash = (first.error.details as { args_hash: string }).args_hash;
  const token = issueElicitToken(v.db, {
    vaultId: "test",
    toolName: "write_attachment",
    argsHash: hash,
    caller: "test",
  });
  return v.call("write_attachment", input, { elicitToken: token });
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const NEW = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);

const made: string[] = [];
function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(d);
  return d;
}
afterEach(() => {
  writeFault.next = [];
  for (const d of made.splice(0)) rmTemp(d);
});

describe("write_attachment overwrite: rollback and the committed marker", () => {
  const key = "rollback-key";
  const input = (overwrite = true) => ({
    vault: "test",
    path: "a.png",
    content: NEW.toString("base64"),
    overwrite,
    options: { idempotency_key: key },
  });
  const state = (v: ReturnType<typeof makeM3Vault>): string | undefined =>
    (
      v.db.prepare("SELECT state FROM idempotency_keys WHERE key = ?").get(key) as
        | { state: string }
        | undefined
    )?.state;

  it("a failed write that is fully rolled back leaves the claim re-runnable (not indeterminate)", async () => {
    const v = makeM3Vault({ files: {} });
    try {
      writeFileSync(join(v.root, "a.png"), PNG);
      writeFault.next = ["fail"];
      const a = await confirmed(v, input());
      expect(a.ok).toBe(false);
      // prior bytes restored in place
      expect(readFileSync(join(v.root, "a.png")).equals(PNG)).toBe(true);
      // RED before the fix: the marker ran before the write, so this read "indeterminate".
      expect(state(v)).not.toBe("indeterminate");
      expect(state(v)).not.toBe("effect_committed");
      // and the retry with the same key simply succeeds
      const b = await confirmed(v, input());
      expect(b.ok).toBe(true);
      expect(readFileSync(join(v.root, "a.png")).equals(NEW)).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("a failed write whose restore ALSO fails records indeterminate (truly half-applied)", async () => {
    const v = makeM3Vault({ files: {} });
    try {
      writeFileSync(join(v.root, "a.png"), PNG);
      writeFault.next = ["fail-and-occupy"];
      const a = await confirmed(v, input());
      expect(a.ok).toBe(false);
      expect(state(v)).toBe("indeterminate");
      const b = await confirmed(v, input());
      expect(b.ok).toBe(false);
      if (!b.ok) expect(b.error.code).toBe("indeterminate_outcome");
    } finally {
      v.cleanup();
    }
  });

  it("a successful overwrite is committed and trashes the prior bytes", async () => {
    const v = makeM3Vault({ files: {} });
    try {
      writeFileSync(join(v.root, "a.png"), PNG);
      const a = await confirmed(v, input());
      expect(a.ok).toBe(true);
      if (a.ok)
        expect((a.data as { trashed_prev_to: string }).trashed_prev_to).toBe(".trash/a.png");
      expect(readFileSync(join(v.root, ".trash", "a.png")).equals(PNG)).toBe(true);
      expect(state(v)).toBe("completed");
    } finally {
      v.cleanup();
    }
  });

  it("a planted .trash symlink stops an overwrite before anything moves", async () => {
    const v = makeM3Vault({ files: {} });
    const outside = tmp("otc-tr-out-");
    try {
      writeFileSync(join(v.root, "a.png"), PNG);
      if (!trySymlink(fs, outside, join(v.root, ".trash"))) return;
      const a = await confirmed(v, input());
      expect(a.ok).toBe(false);
      expect(readFileSync(join(v.root, "a.png")).equals(PNG)).toBe(true);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      v.cleanup();
    }
  });
});
