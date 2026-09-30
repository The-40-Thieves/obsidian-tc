// A vault's own ACL override (aclByVault) must govern EVERY note-read surface, not only the tools
// that name a `vault` argument. read_notes gets it from dispatch's applyVaultAcl swap; resources/read,
// resources/list and read_resources name the vault only inside a URI, so before the fix they were
// authorized by the ROOT ACL (typically unrestricted) against the bound vault. Each case pairs a
// permissive root with a narrowing override and asserts the same principal + path gets the same
// verdict from all four surfaces, with an existence floor so "all allow" cannot pass vacuously.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import type { AclConfigT } from "../src/acl";
import type { CallerContext } from "../src/mcp/registry";
import { buildResourceUri } from "../src/mcp/resources";
import { createMcpServer } from "../src/mcp/server";
import { makeTestVault, type TestVault } from "./m1-helpers";

const vaults: TestVault[] = [];
afterEach(() => {
  for (const v of vaults.splice(0)) v.cleanup();
});

const FILES = { "pub/a.md": "PUBLIC", "secret/b.md": "SECRET", "top.md": "TOP" };

interface Case {
  name: string;
  override: Partial<AclConfigT>;
  scopes: string[];
  /** path -> should the principal be allowed to read it */
  expect: Record<string, boolean>;
  /** resources/list, like list_notes, filters by the read whitelist only (a path's rule-scopes gate
   *  the READ, not the listing), so it can advertise more than the caller may read. */
  listed?: string[];
}

const CASES: Case[] = [
  {
    name: "readPaths whitelist",
    override: { readPaths: ["pub/**"] },
    scopes: ["read:notes"],
    expect: { "pub/a.md": true, "secret/b.md": false, "top.md": false },
  },
  {
    name: "strictReadDefault (no whitelist -> reads fail closed)",
    override: { strictReadDefault: true },
    scopes: ["read:notes"],
    expect: { "pub/a.md": false, "secret/b.md": false, "top.md": false },
  },
  {
    name: "rule-scopes gate a folder the caller holds no scope for",
    override: { rules: [{ glob: "secret/**", scopes: ["read:secret"] }] },
    scopes: ["read:notes"],
    expect: { "pub/a.md": true, "secret/b.md": false, "top.md": true },
    listed: ["pub/a.md", "secret/b.md", "top.md"],
  },
];

type Verdict = "allow" | "deny";
const verdict = (allowed: boolean): Verdict => (allowed ? "allow" : "deny");

function harness(c: Case) {
  const v = makeTestVault({ files: FILES, centralAcl: true, aclByVault: { test: c.override } });
  vaults.push(v);
  const context = (): CallerContext => v.ctx({ grantedScopes: new Set(c.scopes) });
  return { v, context };
}

async function connect(v: TestVault, context: () => CallerContext) {
  const server = createMcpServer({
    name: "x",
    version: "0",
    registry: v.registry,
    context,
    visibility: { grantedScopes: new Set(context().grantedScopes) },
    vaultRegistry: v.vaultRegistry,
    facadeMode: "triad",
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function viaReadNotes(v: TestVault, context: () => CallerContext, path: string) {
  const r = await v.registry.dispatch("read_notes", { vault: v.id, paths: [path] }, context());
  return verdict(r.ok);
}

async function viaReadResources(v: TestVault, context: () => CallerContext, path: string) {
  const r = await v.registry.dispatch(
    "read_resources",
    { uris: [buildResourceUri(v.id, path)] },
    context(),
  );
  if (!r.ok) return "deny";
  const item = (r.data as { results: { ok: boolean }[] }).results[0];
  return verdict(item?.ok === true);
}

async function viaResourcesRead(client: Client, v: TestVault, path: string) {
  try {
    const r = await client.readResource({ uri: buildResourceUri(v.id, path) });
    return verdict(r.contents.length > 0);
  } catch {
    return "deny";
  }
}

describe("per-vault ACL governs read_notes, read_resources, resources/read and resources/list alike", () => {
  for (const c of CASES) {
    describe(c.name, () => {
      it("parity table: same principal + path -> same verdict on every surface", async () => {
        const { v, context } = harness(c);
        const { client, close } = await connect(v, context);
        try {
          const table: Record<string, Record<string, Verdict>> = {};
          for (const path of Object.keys(c.expect)) {
            table[path] = {
              read_notes: await viaReadNotes(v, context, path),
              read_resources: await viaReadResources(v, context, path),
              "resources/read": await viaResourcesRead(client, v, path),
            };
          }
          const want = Object.fromEntries(
            Object.entries(c.expect).map(([p, a]) => [
              p,
              { read_notes: verdict(a), read_resources: verdict(a), "resources/read": verdict(a) },
            ]),
          );
          expect(table).toEqual(want);
          // Existence floor: the case must actually deny something, or it proves nothing.
          expect(Object.values(c.expect)).toContain(false);
        } finally {
          await close();
        }
      });

      it("resources/list advertises only the notes the override lets the caller read", async () => {
        const { v, context } = harness(c);
        const { client, close } = await connect(v, context);
        try {
          const listed = (await client.listResources()).resources
            .map((r) => r.name)
            .filter((n) => n.endsWith(".md"))
            .sort();
          const allowed =
            c.listed ??
            Object.entries(c.expect)
              .filter(([, ok]) => ok)
              .map(([p]) => p)
              .sort();
          expect(listed).toEqual(allowed);
        } finally {
          await close();
        }
      });
    });
  }

  it("a vault WITHOUT an override still inherits the root ACL on the resource surfaces", async () => {
    const v = makeTestVault({
      files: FILES,
      centralAcl: true,
      acl: { readOnly: false, defaultScopes: [], rules: [], readPaths: ["pub/**"] },
      aclByVault: { elsewhere: { readPaths: ["top.md"] } },
    });
    vaults.push(v);
    const context = (): CallerContext => v.ctx();
    const { client, close } = await connect(v, context);
    try {
      expect(await viaReadResources(v, context, "pub/a.md")).toBe("allow");
      expect(await viaReadResources(v, context, "secret/b.md")).toBe("deny");
      expect(await viaResourcesRead(client, v, "secret/b.md")).toBe("deny");
    } finally {
      await close();
    }
  });
});
