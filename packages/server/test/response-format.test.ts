// GH #1027: the shared `response_format` parameter and its resolver. Precedence, in order:
// explicit response_format > the legacy `verbosity` alias (terse -> concise, full -> detailed) >
// the config default > "detailed".
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ResponseFormatInput, resolveResponseFormat } from "../src/tools/response-format";

describe("resolveResponseFormat precedence", () => {
  it("falls back to detailed when nothing is set", () => {
    expect(resolveResponseFormat({})).toBe("detailed");
    expect(resolveResponseFormat({}, undefined)).toBe("detailed");
  });

  it("uses the config default when the call names neither field", () => {
    expect(resolveResponseFormat({}, "concise")).toBe("concise");
    expect(resolveResponseFormat({}, "detailed")).toBe("detailed");
  });

  it("the legacy verbosity alias maps terse -> concise and full -> detailed", () => {
    expect(resolveResponseFormat({ verbosity: "terse" })).toBe("concise");
    expect(resolveResponseFormat({ verbosity: "full" })).toBe("detailed");
  });

  it("the alias beats the config default, in both directions", () => {
    expect(resolveResponseFormat({ verbosity: "terse" }, "detailed")).toBe("concise");
    expect(resolveResponseFormat({ verbosity: "full" }, "concise")).toBe("detailed");
  });

  it("an explicit response_format beats the alias and the config default", () => {
    expect(
      resolveResponseFormat({ response_format: "detailed", verbosity: "terse" }, "concise"),
    ).toBe("detailed");
    expect(
      resolveResponseFormat({ response_format: "concise", verbosity: "full" }, "detailed"),
    ).toBe("concise");
    expect(resolveResponseFormat({ response_format: "concise" }, "detailed")).toBe("concise");
    expect(resolveResponseFormat({ response_format: "detailed" }, "concise")).toBe("detailed");
  });
});

describe("ResponseFormatInput schema fragment", () => {
  const schema = z.object(ResponseFormatInput).strict();

  it("both fields are optional, so an unset call parses to an empty object (no injected default)", () => {
    expect(schema.parse({})).toEqual({});
  });

  it("accepts the two formats and the two legacy verbosity values, rejects anything else", () => {
    expect(schema.parse({ response_format: "concise" })).toEqual({ response_format: "concise" });
    expect(schema.parse({ verbosity: "terse" })).toEqual({ verbosity: "terse" });
    expect(schema.safeParse({ response_format: "terse" }).success).toBe(false);
    expect(schema.safeParse({ verbosity: "concise" }).success).toBe(false);
  });
});

describe("config default tools.defaults.responseFormat", () => {
  const base = { vaults: [{ id: "v", path: "/tmp/v" }] };

  it("ships as detailed, including when the tools block is absent", () => {
    expect(ServerConfigSchema.parse(base).tools.defaults.responseFormat).toBe("detailed");
    expect(ServerConfigSchema.parse({ ...base, tools: {} }).tools.defaults.responseFormat).toBe(
      "detailed",
    );
  });

  it("accepts concise and rejects an unknown format", () => {
    const ok = ServerConfigSchema.parse({
      ...base,
      tools: { defaults: { responseFormat: "concise" } },
    });
    expect(ok.tools.defaults.responseFormat).toBe("concise");
    expect(
      ServerConfigSchema.safeParse({ ...base, tools: { defaults: { responseFormat: "terse" } } })
        .success,
    ).toBe(false);
  });
});
