// Drift guard for the home-server templates under deploy/homeserver/ (Umbrel, CasaOS, Unraid). Each
// template runs the same container as deploy/compose.http.yml, with the LAN settings a home server
// needs: a vault folder the user picks, a /data volume, an exact allow-list of hosts, a JWT secret
// that is never a literal value, and no public URL. Umbrel and CasaOS are YAML and are parsed as
// such. Unraid is XML and is read with a small reader, because the repo has no XML parser.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const homeRoot = join(repoRoot, "deploy/homeserver");
const composePath = join(repoRoot, "deploy/compose.http.yml");
const sharedConfigPath = join(repoRoot, "deploy/config/obsidian-tc.config.json");
const umbrelStorePath = join(homeRoot, "umbrel/umbrel-app-store.yml");
const umbrelAppDir = join(homeRoot, "umbrel/thieves-obsidian-tc");
const casaosPath = join(homeRoot, "casaos/docker-compose.yml");
const unraidPath = join(homeRoot, "unraid/obsidian-tc.xml");
const serviceName = "obsidian-tc";
const configTarget = "/config/obsidian-tc.config.json";
const port = 8765;
// An exact `host` or `host:port` entry, or a compose variable that expands to one. No `*`, scheme or path.
const hostEntry = /^(\$\{\w+\}|[a-z0-9.-]+)(:\d{1,5})?$/i;

const readText = (path: string): string => readFileSync(path, "utf8");

type Mount = string | { type?: string; source?: string; target: string; read_only?: boolean };

interface ComposeService {
  image?: string;
  environment?: Record<string, string> | string[];
  ports?: Array<string | { target: number | string; published?: string }>;
  volumes?: Mount[];
  configs?: Array<string | { source: string; target?: string }>;
  healthcheck?: unknown;
}

interface ComposeFile {
  services?: Record<string, ComposeService>;
  configs?: Record<string, { content?: string }>;
}

// What a template asks the platform to run, normalised so one set of assertions covers all three.
interface Home {
  image: string | undefined;
  env: Record<string, string>;
  ports: number[];
  mounts: Record<string, { readOnly: boolean }>;
  config: unknown;
  healthcheck: unknown;
}

function envOf(environment: ComposeService["environment"]): Record<string, string> {
  if (!environment) return {};
  if (!Array.isArray(environment)) {
    return Object.fromEntries(Object.entries(environment).map(([k, v]) => [k, String(v)]));
  }
  return Object.fromEntries(
    environment.map((item) => {
      const eq = item.indexOf("=");
      return eq < 0 ? [item, ""] : [item.slice(0, eq), item.slice(eq + 1)];
    }),
  );
}

function mountOf(mount: Mount): { target: string; readOnly: boolean } {
  if (typeof mount === "string") {
    const [, target = "", mode] = mount.split(":");
    return { target, readOnly: mode === "ro" };
  }
  return { target: mount.target, readOnly: mount.read_only === true };
}

function fromCompose(doc: ComposeFile, key: string): Home {
  const service = doc.services?.[key];
  const configRef = (service?.configs ?? [])
    .map((c) => (typeof c === "string" ? { source: c, target: undefined } : c))
    .find((c) => c.target === configTarget);
  const content = configRef ? doc.configs?.[configRef.source]?.content : undefined;
  return {
    image: service?.image,
    env: envOf(service?.environment),
    ports: (service?.ports ?? []).map((p) =>
      typeof p === "string" ? Number(p.split(":").at(-1)) : Number(p.target),
    ),
    mounts: Object.fromEntries(
      (service?.volumes ?? []).map((m) => {
        const { target, readOnly } = mountOf(m);
        return [target, { readOnly }];
      }),
    ),
    config: content === undefined ? undefined : JSON.parse(content),
    healthcheck: service?.healthcheck,
  };
}

const base = (() => {
  const compose = parse(readText(composePath)) as ComposeFile;
  const env = envOf(compose.services?.[serviceName]?.environment);
  return {
    image: compose.services?.[serviceName]?.image,
    env,
    sharedConfig: JSON.parse(readText(sharedConfigPath)) as unknown,
  };
})();

function loadUmbrel(): Home {
  const doc = parse(readText(join(umbrelAppDir, "docker-compose.yml"))) as ComposeFile;
  const home = fromCompose(doc, "main");
  const proxy = envOf(doc.services?.app_proxy?.environment);
  return { ...home, ports: [Number(proxy.APP_PORT)] };
}

function loadCasaos(): Home {
  return fromCompose(parse(readText(casaosPath)) as ComposeFile, serviceName);
}

// Unraid's <Config> entries are self-closing attribute lists; `<Config>text</Config>` is not used.
function xmlConfigs(xml: string): Array<Record<string, string>> {
  return [...xml.matchAll(/<Config\b([^>]*)>/g)].map((m) =>
    Object.fromEntries([...(m[1] ?? "").matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]])),
  );
}

function xmlTag(xml: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1];
}

function loadUnraid(): Home {
  const xml = readText(unraidPath);
  const configs = xmlConfigs(xml);
  const env: Record<string, string> = {};
  const mounts: Home["mounts"] = {};
  const ports: number[] = [];
  for (const c of configs) {
    if (c.Type === "Variable") env[c.Target ?? ""] = c.Default ?? "";
    if (c.Type === "Path") mounts[c.Target ?? ""] = { readOnly: c.Mode === "ro" };
    if (c.Type === "Port") ports.push(Number(c.Target));
  }
  return {
    image: xmlTag(xml, "Repository"),
    env,
    ports,
    mounts,
    config: undefined,
    healthcheck: undefined,
  };
}

const templates = [
  { name: "casaos", load: loadCasaos },
  { name: "umbrel", load: loadUmbrel },
];

describe("deploy/homeserver templates", () => {
  it("holds exactly the three platform directories, so a new platform needs a test row", () => {
    const dirs = readdirSync(homeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirs).toEqual(["casaos", "umbrel", "unraid"]);
  });

  it("reads the real base image, config env and port from compose.http.yml", () => {
    expect(base.image).toBe("ghcr.io/the-40-thieves/obsidian-tc:latest");
    expect(base.env.OBSIDIAN_TC_CONFIG).toBe(configTarget);
    expect(base.env.PORT).toBe(`\${PORT:-8765}`);
  });

  it.each([...templates, { name: "unraid", load: loadUnraid }])(
    "$name: runs the image compose.http.yml runs",
    ({ load }) => {
      expect(load().image).toBe(base.image);
    },
  );

  it.each([...templates, { name: "unraid", load: loadUnraid }])(
    "$name: listens on port 8765",
    ({ load }) => {
      expect(load().ports).toContain(port);
    },
  );

  it.each([...templates, { name: "unraid", load: loadUnraid }])(
    "$name: sets the config, cache and port env like compose.http.yml",
    ({ load }) => {
      const { env } = load();
      expect(env.OBSIDIAN_TC_CONFIG).toBe(configTarget);
      expect(env.OBSIDIAN_TC_CACHE_DIR).toBe("/data/cache");
      expect(env.PORT).toBe(String(port));
    },
  );

  it.each([...templates, { name: "unraid", load: loadUnraid }])(
    "$name: mounts the vault folder read-write at OBSIDIAN_TC_VAULT_PATH, not inside /data",
    ({ load }) => {
      const home = load();
      const vault = home.env.OBSIDIAN_TC_VAULT_PATH;
      expect(vault).toBe("/vault");
      expect(home.mounts[vault ?? ""]).toEqual({ readOnly: false });
    },
  );

  it.each([...templates, { name: "unraid", load: loadUnraid }])(
    "$name: mounts /data read-write for the cache",
    ({ load }) => {
      expect(load().mounts["/data"]).toEqual({ readOnly: false });
    },
  );

  it.each([...templates, { name: "unraid", load: loadUnraid }])(
    "$name: sets no public URL, so the LAN default never asks for https",
    ({ load }) => {
      expect(load().env).not.toHaveProperty("OBSIDIAN_TC_PUBLIC_URL");
    },
  );

  it.each([...templates, { name: "unraid", load: loadUnraid }])(
    "$name: never sets a literal JWT secret; the value is empty or a platform reference",
    ({ load }) => {
      expect(load().env.OBSIDIAN_TC_JWT_SECRET).toMatch(/^(|\$\{\w+\})$/);
    },
  );

  it.each([...templates, { name: "unraid", load: loadUnraid }])(
    "$name: sets OBSIDIAN_TC_ALLOWED_HOSTS as exact host:port entries, never a wildcard",
    ({ load }) => {
      const entries = (load().env.OBSIDIAN_TC_ALLOWED_HOSTS ?? "").split(",");
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry).not.toBe("*");
        expect(entry).toMatch(hostEntry);
      }
    },
  );

  it.each([...templates, { name: "unraid", load: loadUnraid }])(
    "$name: sets OBSIDIAN_TC_AUDIENCE, which a non-loopback jwt server needs without a public URL",
    ({ load }) => {
      expect(load().env.OBSIDIAN_TC_AUDIENCE).toMatch(/^http:\/\/[^/\s]+$/);
    },
  );

  it.each([...templates, { name: "unraid", load: loadUnraid }])(
    "$name: declares no healthcheck, or one that probes /healthz",
    ({ load }) => {
      const { healthcheck } = load();
      if (healthcheck !== undefined) expect(JSON.stringify(healthcheck)).toContain("/healthz");
    },
  );

  it.each([...templates, { name: "unraid", load: loadUnraid }])(
    "$name: never sets auth.mode none in its text",
    ({ name }) => {
      const files =
        name === "unraid"
          ? [unraidPath]
          : name === "casaos"
            ? [casaosPath]
            : [join(umbrelAppDir, "docker-compose.yml"), join(umbrelAppDir, "exports.sh")];
      for (const file of files) {
        expect(readText(file)).not.toMatch(/mode"?:\s*"?none\b/);
      }
    },
  );

  it.each(templates)("$name: ships the shared config JSON at the config path", ({ load }) => {
    expect(load().config).toEqual(base.sharedConfig);
  });
});

describe("CasaOS template", () => {
  it("is a v2 store compose file with one x-casaos block whose main is the service", () => {
    const doc = parse(readText(casaosPath)) as ComposeFile & {
      name?: string;
      "x-casaos"?: { id?: string; main?: string; port_map?: string; category?: string };
    };
    expect(doc.name).toBe("obsidian-tc");
    expect(doc["x-casaos"]?.main).toBe(serviceName);
    expect(doc["x-casaos"]?.port_map).toBe(String(port));
    expect(doc["x-casaos"]?.id).toMatch(/^[a-z0-9]+(\.[a-z0-9_-]+)+$/);
    expect(doc["x-casaos"]?.category).toBe("AI");
  });

  it("leaves the JWT secret empty, so the install asks for it and never ships a default", () => {
    const { env } = loadCasaos();
    expect(env.OBSIDIAN_TC_JWT_SECRET).toBe("");
  });
});

describe("Umbrel template", () => {
  it("is a community store: the store id prefixes the app directory and the manifest id", () => {
    const store = parse(readText(umbrelStorePath)) as { id: string; name: string };
    const manifest = parse(readText(join(umbrelAppDir, "umbrel-app.yml"))) as { id: string };
    expect(store.id).toMatch(/^[a-z-]+$/);
    expect(manifest.id).toBe("thieves-obsidian-tc");
    expect(manifest.id.startsWith(`${store.id}-`)).toBe(true);
    expect(manifest.id).toBe(basename(umbrelAppDir));
  });

  it("declares the app port, the 2.0 storage root and the picked vault folder", () => {
    const manifest = parse(readText(join(umbrelAppDir, "umbrel-app.yml"))) as {
      port: number;
      version: string;
      storage: { dataRoot: string };
      folderAccess: Array<{ mounts: Array<{ service: string; targetPath: string }> }>;
    };
    expect(manifest.port).toBe(port);
    expect(manifest.version).not.toBe("latest");
    expect(manifest.storage.dataRoot).toBe("data");
    expect(manifest.folderAccess[0]?.mounts).toContainEqual({
      service: "main",
      targetPath: "/vault",
    });
  });

  it("lets bearer clients reach /mcp and /.well-known without the Umbrel login, and never turns the whole app public", () => {
    const doc = parse(readText(join(umbrelAppDir, "docker-compose.yml"))) as ComposeFile;
    const proxy = envOf(doc.services?.app_proxy?.environment);
    expect(proxy.PROXY_AUTH_WHITELIST?.split(",")).toEqual(
      expect.arrayContaining(["/mcp", "/mcp/*", "/.well-known/*"]),
    );
    expect(proxy.PROXY_AUTH_ADD).not.toBe("false");
    expect(proxy.APP_PORT).toBe(String(port));
  });

  it("derives the JWT secret per install in exports.sh and passes it through the compose reference", () => {
    const exportsSh = readText(join(umbrelAppDir, "exports.sh"));
    expect(exportsSh).toMatch(
      /^export APP_THIEVES_OBSIDIAN_TC_JWT_SECRET="\$\(derive_entropy "\$\{app_entropy_identifier\}-jwt-secret"\)"$/m,
    );
    const { env } = loadUmbrel();
    expect(env.OBSIDIAN_TC_JWT_SECRET).toBe(`\${APP_THIEVES_OBSIDIAN_TC_JWT_SECRET}`);
  });
});

describe("Unraid template", () => {
  const xml = () => readText(unraidPath);

  it("is one Container version 2 document with the image, bridge network and no privileges", () => {
    const text = xml();
    expect(text).toMatch(/^<\?xml version="1\.0"\?>\s*<Container version="2">/);
    expect(text.trimEnd()).toMatch(/<\/Container>$/);
    expect(xmlTag(text, "Repository")).toBe("ghcr.io/the-40-thieves/obsidian-tc:latest");
    expect(xmlTag(text, "Network")).toBe("bridge");
    expect(xmlTag(text, "Privileged")).toBe("false");
  });

  it("masks the JWT secret, makes it required, and leaves its default empty", () => {
    const secret = xmlConfigs(xml()).find((c) => c.Target === "OBSIDIAN_TC_JWT_SECRET");
    expect(secret).toMatchObject({ Type: "Variable", Default: "", Required: "true", Mask: "true" });
  });

  it("mounts the vault folder with no default, so the user must pick it", () => {
    const vault = xmlConfigs(xml()).find((c) => c.Target === "/vault");
    expect(vault).toMatchObject({ Type: "Path", Default: "", Required: "true", Mode: "rw" });
  });

  it("mounts /config read-only and names the config file the user must place there", () => {
    const config = xmlConfigs(xml()).find((c) => c.Target === "/config");
    expect(config).toMatchObject({ Type: "Path", Mode: "ro" });
    expect(xmlTag(xml(), "Overview")).toContain("obsidian-tc.config.json");
  });

  it("publishes port 8765 and sets no WebUI or extra Docker healthcheck", () => {
    const text = xml();
    expect(xmlConfigs(text)).toContainEqual(
      expect.objectContaining({ Type: "Port", Target: "8765", Default: "8765" }),
    );
    expect(text).not.toMatch(/<WebUI>/);
    expect(text).not.toMatch(/--health-cmd/);
  });
});
