import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import type { CallerContext } from "../src/mcp/registry";
import type { M4Deps } from "../src/tools/m4/shared";
import { buildTemplaterTools } from "../src/tools/m4/templater-tools";

const deps = {
  vaultRegistry: { resolve: () => ({ id: "v1", root: "/tmp/v1" }) },
} as unknown as M4Deps;

function ctx(acl?: FolderAcl): CallerContext {
  return {
    caller: "t",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "v1",
    db: {} as never,
    acl,
  };
}

describe("THE-270 bridge fail-closed", () => {
  it("list_templates refuses under a read whitelist (before touching the bridge)", async () => {
    const listTpl = buildTemplaterTools(deps).find((t) => t.name === "list_templates");
    if (!listTpl) throw new Error("list_templates not found");
    const acl = new FolderAcl({
      readOnly: false,
      defaultScopes: [],
      rules: [],
      readPaths: ["Templates/**"],
    });
    await expect(listTpl.handler({ vault: "v1" }, ctx(acl))).rejects.toMatchObject({
      code: "acl_denied",
    });
  });
});
