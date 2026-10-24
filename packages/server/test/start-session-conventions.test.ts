// start_session gains an optional `conventions` field: the root layer's effective rules in concise
// form, only for a caller that holds read:notes and only when the root SCHEMA.md is readable. Its
// description is unchanged (owner decision), and with no root layer the output is exactly today's.
import { describe, expect, it } from "vitest";
import { makeM5Vault } from "./m5-helpers";

const ROOT_LAYER =
  "---\nconventions:\n  version: 1\n  frontmatter:\n    required: [type]\n    values:\n      status: [draft, current]\n---\n# rules\n";
const SESSION_KEYS = ["session_id", "started_at", "trace_path", "vault"];
const DESCRIPTION =
  "Begin a workspace memory session: a SQLite row plus an append-only JSONL trace file.";

describe("start_session conventions", () => {
  it("carries the root layer's concise rules with read:notes", async () => {
    const v = makeM5Vault({ files: { "SCHEMA.md": ROOT_LAYER } });
    try {
      const r = await v.call("start_session", { vault: "test", caller: "agent-x" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.data as Record<string, unknown>;
      expect(d.conventions).toEqual({
        type_key: { value: "type" },
        required: { values: ["type"] },
        values: { status: { values: ["draft", "current"] } },
        types: {},
      });
      expect(JSON.stringify(d.conventions)).not.toContain('"source"');
    } finally {
      v.cleanup();
    }
  });

  it("is absent without read:notes", async () => {
    const v = makeM5Vault({ files: { "SCHEMA.md": ROOT_LAYER } });
    try {
      const r = await v.call(
        "start_session",
        { vault: "test", caller: "agent-x" },
        { grantedScopes: new Set(["write:workspace"]) },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data).not.toHaveProperty("conventions");
    } finally {
      v.cleanup();
    }
  });

  it("output deep-equals today's when there is no root layer", async () => {
    const v = makeM5Vault({ files: { "n.md": "x" } });
    try {
      const r = await v.call("start_session", { vault: "test", caller: "agent-x" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(Object.keys(r.data as object).sort()).toEqual(SESSION_KEYS);
    } finally {
      v.cleanup();
    }
  });

  it("description is byte-identical to before", () => {
    const v = makeM5Vault();
    try {
      expect(v.registry.list().find((t) => t.name === "start_session")?.description).toBe(
        DESCRIPTION,
      );
    } finally {
      v.cleanup();
    }
  });
});
