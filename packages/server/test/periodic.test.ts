import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import type { BridgeClient } from "../src/bridge";
import { makeM3Vault } from "./m3-helpers";

describe("Domain 12: Periodic Notes", () => {
  it("get/create/get round-trips a daily note and audits the create", async () => {
    const v = makeM3Vault();
    try {
      const before = await v.call("get_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
      });
      expect(before.ok).toBe(true);
      if (before.ok) expect((before.data as { exists: boolean }).exists).toBe(false);

      const c = await v.call("create_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
      });
      expect(c.ok).toBe(true);
      if (c.ok) expect((c.data as { path: string }).path).toBe("2026-06-18.md");
      expect(v.exists("2026-06-18.md")).toBe(true);

      const after = await v.call("get_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
      });
      if (after.ok) expect((after.data as { exists: boolean }).exists).toBe(true);

      expect(
        v.events().some((e) => e.tool_name === "create_periodic_note" && e.status === "ok"),
      ).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("create_periodic_note fails when the note already exists", async () => {
    const v = makeM3Vault({ files: { "2026-06-18.md": "x" } });
    try {
      const r = await v.call("create_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("note_exists");
    } finally {
      v.cleanup();
    }
  });

  it("create_periodic_note copies a template_override verbatim", async () => {
    const v = makeM3Vault({ files: { "templates/daily.md": "# Daily\n- [ ] task\n" } });
    try {
      const c = await v.call("create_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
        template_override: "templates/daily.md",
      });
      expect(c.ok).toBe(true);
      if (c.ok)
        expect((c.data as { template_used: string }).template_used).toBe("templates/daily.md");
      expect(v.read("2026-06-18.md")).toBe("# Daily\n- [ ] task\n");
    } finally {
      v.cleanup();
    }
  });

  it("find_or_create_periodic_note creates once, then reports created=false", async () => {
    const v = makeM3Vault();
    try {
      const first = await v.call("find_or_create_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
      });
      expect(first.ok).toBe(true);
      if (first.ok) expect((first.data as { created: boolean }).created).toBe(true);
      const second = await v.call("find_or_create_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
      });
      if (second.ok) expect((second.data as { created: boolean }).created).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("append_to_periodic_note inserts under an existing heading section", async () => {
    const v = makeM3Vault({
      files: { "2026-06-18.md": "# Day\n\n## Log\nexisting\n\n## Notes\nn\n" },
    });
    try {
      const a = await v.call("append_to_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
        content: "new line",
        heading: "Log",
      });
      expect(a.ok).toBe(true);
      const body = v.read("2026-06-18.md");
      expect(body).toContain("existing\n\nnew line\n## Notes");
    } finally {
      v.cleanup();
    }
  });

  it("append_to_periodic_note creates the note when absent and reports byte delta", async () => {
    const v = makeM3Vault();
    try {
      const a = await v.call("append_to_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
        content: "hello",
      });
      expect(a.ok).toBe(true);
      if (a.ok) {
        const d = a.data as { created: boolean; appended_bytes: number };
        expect(d.created).toBe(true);
        expect(d.appended_bytes).toBe(5);
      }
      expect(v.read("2026-06-18.md")).toContain("hello");
    } finally {
      v.cleanup();
    }
  });

  it("list_periodic_notes enumerates existing notes in a date range", async () => {
    const v = makeM3Vault({
      files: { "2026-06-16.md": "a", "2026-06-17.md": "b", "2026-06-18.md": "c" },
    });
    try {
      const l = await v.call("list_periodic_notes", {
        vault: "test",
        period: "daily",
        from: "2026-06-16",
        to: "2026-06-18",
      });
      expect(l.ok).toBe(true);
      if (l.ok) {
        const d = l.data as { total: number; items: Array<{ path: string }> };
        expect(d.total).toBe(3);
        expect(d.items.map((i) => i.path).sort()).toEqual([
          "2026-06-16.md",
          "2026-06-17.md",
          "2026-06-18.md",
        ]);
      }
    } finally {
      v.cleanup();
    }
  });

  it("resolves the daily-notes core-plugin config (folder + format)", async () => {
    const v = makeM3Vault({
      files: {
        ".obsidian/daily-notes.json": JSON.stringify({ folder: "Journal", format: "YYYY-MM-DD" }),
      },
    });
    try {
      const c = await v.call("create_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
      });
      expect(c.ok).toBe(true);
      if (c.ok) expect((c.data as { path: string }).path).toBe("Journal/2026-06-18.md");
      expect(v.exists("Journal/2026-06-18.md")).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("a create outside the write whitelist is acl_denied", async () => {
    const v = makeM3Vault({ acl: { writePaths: ["Journal/**"] } });
    try {
      const denied = await v.call("create_periodic_note", {
        vault: "test",
        period: "daily",
        date: "2026-06-18",
      });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("acl_denied");
    } finally {
      v.cleanup();
    }
  });
});

describe("Domain 12: Periodic Notes — Templater expansion (THE-207)", () => {
  const daily = { vault: "test", period: "daily", date: "2026-06-18" } as const;

  function stubBridge(opts: { throwCode?: string } = {}) {
    const calls: Array<Record<string, unknown>> = [];
    const templaterBridge = () => ({
      client: {
        request: async (req: { body?: Record<string, unknown> }) => {
          calls.push(req.body ?? {});
          if (opts.throwCode)
            throw new ObsidianTcError(
              opts.throwCode as ConstructorParameters<typeof ObsidianTcError>[0],
              "degraded",
            );
          return {};
        },
      } as unknown as BridgeClient,
      timeoutMs: 1000,
    });
    return { templaterBridge, calls };
  }

  it("expand_template without write:templater is forbidden", async () => {
    const { templaterBridge } = stubBridge();
    const v = makeM3Vault({ files: { "templates/daily.md": "BODY" }, templaterBridge });
    try {
      const r = await v.call(
        "create_periodic_note",
        { ...daily, template_override: "templates/daily.md", expand_template: true },
        { grantedScopes: new Set(["write:periodic"]) },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("forbidden");
    } finally {
      v.cleanup();
    }
  });

  it("expand_template delegates the write to Templater and skips the verbatim copy", async () => {
    const { templaterBridge, calls } = stubBridge();
    const v = makeM3Vault({
      files: { "templates/daily.md": "# <% tp.date.now() %>" },
      templaterBridge,
    });
    try {
      const r = await v.call("create_periodic_note", {
        ...daily,
        template_override: "templates/daily.md",
        expand_template: true,
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { template_expanded: boolean }).template_expanded).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        template: "templates/daily.md",
        target: "2026-06-18.md",
        overwrite: false,
      });
      // The bridge (companion) owns the write; the tool must skip its verbatim copy.
      expect(v.exists("2026-06-18.md")).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("degrades to a verbatim copy when Templater is unavailable", async () => {
    const { templaterBridge } = stubBridge({ throwCode: "plugin_missing" });
    const v = makeM3Vault({ files: { "templates/daily.md": "TEMPLATE BODY" }, templaterBridge });
    try {
      const r = await v.call("create_periodic_note", {
        ...daily,
        template_override: "templates/daily.md",
        expand_template: true,
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { template_expanded: boolean }).template_expanded).toBe(false);
      expect(v.exists("2026-06-18.md")).toBe(true);
      expect(v.read("2026-06-18.md")).toContain("TEMPLATE BODY");
    } finally {
      v.cleanup();
    }
  });

  it("without a Templater bridge, expand_template degrades to a verbatim copy", async () => {
    const v = makeM3Vault({ files: { "templates/daily.md": "BODY" } });
    try {
      const r = await v.call("create_periodic_note", {
        ...daily,
        template_override: "templates/daily.md",
        expand_template: true,
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { template_expanded: boolean }).template_expanded).toBe(false);
      expect(v.exists("2026-06-18.md")).toBe(true);
    } finally {
      v.cleanup();
    }
  });
});
