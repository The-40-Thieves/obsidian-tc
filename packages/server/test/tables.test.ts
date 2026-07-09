import { describe, expect, it } from "vitest";
import { makeM3Vault } from "./m3-helpers";

const NOTE = "# Data\n\n| Name | Age |\n|---|--:|\n| bob | 3 |\n| ann | 10 |\n\ntrailing\n";

describe("THE-380 GFM table tools", () => {
  it("format_table realigns columns and preserves surrounding content", async () => {
    const v = makeM3Vault({ files: { "t.md": NOTE } });
    try {
      const r = await v.call("format_table", { vault: "test", path: "t.md" });
      expect(r.ok).toBe(true);
      const out = v.read("t.md");
      expect(out).toContain("# Data");
      expect(out).toContain("trailing");
      expect(out).toContain("| Name | Age |");
      // right-aligned Age column (delimiter had --:)
      expect(out).toMatch(/\|\s+3 \|/);
    } finally {
      v.cleanup();
    }
  });

  it("insert_table_row appends and inserts at a position", async () => {
    const v = makeM3Vault({ files: { "t.md": NOTE } });
    try {
      await v.call("insert_table_row", { vault: "test", path: "t.md", values: ["cy", "7"] });
      const at0 = await v.call("insert_table_row", {
        vault: "test",
        path: "t.md",
        values: ["zz", "1"],
        at: 0,
      });
      expect(at0.ok).toBe(true);
      const out = v.read("t.md");
      const rowsOrder = out.split("\n").filter((l) => /^\| (zz|bob|ann|cy) /.test(l));
      expect(rowsOrder[0]).toContain("zz");
      expect(out).toContain("cy");
    } finally {
      v.cleanup();
    }
  });

  it("insert_table_column adds a header + per-row values", async () => {
    const v = makeM3Vault({ files: { "t.md": NOTE } });
    try {
      const r = await v.call("insert_table_column", {
        vault: "test",
        path: "t.md",
        header: "Tag",
        values: ["x", "y"],
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.data as { columns: number }).columns).toBe(3);
      expect(v.read("t.md")).toContain("Tag");
    } finally {
      v.cleanup();
    }
  });

  it("sort_table_by_column sorts numeric by header name", async () => {
    const v = makeM3Vault({ files: { "t.md": NOTE } });
    try {
      const r = await v.call("sort_table_by_column", {
        vault: "test",
        path: "t.md",
        column: "Age",
        numeric: true,
        order: "asc",
      });
      expect(r.ok).toBe(true);
      const dataRows = v
        .read("t.md")
        .split("\n")
        .filter((l) => /^\| (bob|ann) /.test(l));
      expect(dataRows[0]).toContain("bob"); // 3 < 10
      expect(dataRows[1]).toContain("ann");
    } finally {
      v.cleanup();
    }
  });

  it("errors on a missing table index", async () => {
    const v = makeM3Vault({ files: { "t.md": "no tables here" } });
    try {
      const r = await v.call("format_table", { vault: "test", path: "t.md" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });
});
