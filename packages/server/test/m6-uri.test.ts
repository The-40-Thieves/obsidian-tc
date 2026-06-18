// Unit tests for generate_uri (THE-182 / M6 Domain 27). buildObsidianUri is a pure
// string builder — no vault state, no registry — so these assert exact output and
// percent-encoding for every action, plus invalid_input on a params/action mismatch.
import { ObsidianTcError } from "@obsidian-tc/shared";
import { describe, expect, it } from "vitest";
import { buildObsidianUri, buildUriTools } from "../src/tools/m6/uri-tools";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof ObsidianTcError ? e.code : "non-tc-error";
  }
  return "no-error";
}

describe("buildObsidianUri", () => {
  it("builds an open URI with vault + file, percent-encoding both", () => {
    expect(buildObsidianUri("open", { file: "Daily/2026-06-18.md" }, "My Vault")).toBe(
      "obsidian://open?vault=My%20Vault&file=Daily%2F2026-06-18.md",
    );
  });

  it("omits the vault segment when no vault is given", () => {
    expect(buildObsidianUri("open", { file: "Note.md" })).toBe("obsidian://open?file=Note.md");
  });

  it("appends a heading fragment to the file (encoded)", () => {
    expect(buildObsidianUri("open", { file: "Note", heading: "Section A" }, "v")).toBe(
      "obsidian://open?vault=v&file=Note%23Section%20A",
    );
  });

  it("appends a block-ref fragment to the file (encoded)", () => {
    expect(buildObsidianUri("open", { file: "Note", block: "abc123" }, "v")).toBe(
      "obsidian://open?vault=v&file=Note%23%5Eabc123",
    );
  });

  it("builds a search URI", () => {
    expect(buildObsidianUri("search", { query: "tag:#idea foo & bar" }, "v")).toBe(
      "obsidian://search?vault=v&query=tag%3A%23idea%20foo%20%26%20bar",
    );
  });

  it("builds a new-note URI with optional content", () => {
    expect(buildObsidianUri("new", { file: "Inbox/x.md", content: "hello world" }, "v")).toBe(
      "obsidian://new?vault=v&file=Inbox%2Fx.md&content=hello%20world",
    );
    expect(buildObsidianUri("new", { file: "Inbox/x.md" }, "v")).toBe(
      "obsidian://new?vault=v&file=Inbox%2Fx.md",
    );
  });

  it("builds a daily-note URI via advanced-uri", () => {
    expect(buildObsidianUri("daily", {}, "v")).toBe("obsidian://advanced-uri?vault=v&daily=true");
  });

  it("builds a command URI via advanced-uri", () => {
    expect(buildObsidianUri("command", { commandid: "editor:save-file" }, "v")).toBe(
      "obsidian://advanced-uri?vault=v&commandid=editor%3Asave-file",
    );
  });

  it("builds a hookmark (stable file link) URI with optional uid", () => {
    expect(buildObsidianUri("hookmark", { filepath: "a/b.md", uid: "u-1" }, "v")).toBe(
      "obsidian://advanced-uri?vault=v&filepath=a%2Fb.md&uid=u-1",
    );
  });

  it("builds an advanced URI from arbitrary params", () => {
    expect(
      buildObsidianUri("advanced", { filepath: "n.md", mode: "append", data: "x y" }, "v"),
    ).toBe("obsidian://advanced-uri?vault=v&filepath=n.md&mode=append&data=x%20y");
  });

  it("encodes unicode and reserved characters", () => {
    expect(buildObsidianUri("search", { query: "café/日本?&=" }, "résumé")).toBe(
      "obsidian://search?vault=r%C3%A9sum%C3%A9&query=caf%C3%A9%2F%E6%97%A5%E6%9C%AC%3F%26%3D",
    );
  });

  it("rejects a params/action mismatch with invalid_input", () => {
    expect(code(() => buildObsidianUri("search", {}, "v"))).toBe("invalid_input"); // no query
    expect(code(() => buildObsidianUri("open", {}, "v"))).toBe("invalid_input"); // no file
    expect(code(() => buildObsidianUri("command", {}, "v"))).toBe("invalid_input"); // no commandid
    expect(code(() => buildObsidianUri("advanced", {}, "v"))).toBe("invalid_input"); // empty
    expect(code(() => buildObsidianUri("open", { file: 5 }, "v"))).toBe("invalid_input"); // non-string
  });
});

describe("generate_uri tool", () => {
  const tools = buildUriTools();
  const tool = tools[0];
  if (!tool) throw new Error("generate_uri tool missing");

  it("is a pure read-family tool: no scopes, not destructive", () => {
    expect(tool.name).toBe("generate_uri");
    expect(tool.requiredScopes).toEqual([]);
    expect(tool.destructive ?? false).toBe(false);
  });

  it("returns the built URI from a validated input", async () => {
    const out = (await tool.handler(
      { action: "open", params: { file: "N.md" }, vault: "v" },
      {} as any,
    )) as { uri: string };
    expect(out.uri).toBe("obsidian://open?vault=v&file=N.md");
  });

  it("rejects an unknown action at the schema boundary", () => {
    expect(tool.inputSchema.safeParse({ action: "nope", params: {} }).success).toBe(false);
  });
});
