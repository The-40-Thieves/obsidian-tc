// Drift guard for the self-hosted PaaS templates under deploy/paas/. Each template must run the
// same container as deploy/compose.http.yml: the same image, the same environment defaults, a
// volume at /data, the shipped HTTP config byte-for-byte in content, and port 8765. The platform
// specific parts (how the secret and the public URL are generated) are pinned per platform.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const paasRoot = join(repoRoot, "deploy/paas");
const composePath = join(repoRoot, "deploy/compose.http.yml");
const sharedConfigPath = join(repoRoot, "deploy/config/obsidian-tc.config.json");
const dockerfilePath = join(repoRoot, "Dockerfile");
const serviceName = "obsidian-tc";
const configTarget = "/config/obsidian-tc.config.json";

interface VolumeObject {
  type?: string;
  source?: string;
  target?: string;
  content?: string;
}

interface ComposeService {
  image?: string;
  restart?: string;
  ports?: unknown;
  expose?: unknown;
  container_name?: string;
  networks?: unknown;
  healthcheck?: unknown;
  environment?: Record<string, string> | string[];
  volumes?: Array<string | VolumeObject>;
}

interface ComposeFile {
  services?: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
}

interface Normalized {
  image: string | undefined;
  env: Record<string, string>;
  volumeTargets: string[];
  configJson: unknown;
  httpPort: number;
  healthcheck: unknown;
}

const readText = (path: string): string => readFileSync(path, "utf8");

// Accepts the list form (KEY=value or a bare KEY) and the map form.
function envOf(environment: ComposeService["environment"]): Record<string, string> {
  if (!environment) return {};
  if (!Array.isArray(environment)) {
    return Object.fromEntries(
      Object.entries(environment).map(([key, value]) => [key, String(value)]),
    );
  }
  return Object.fromEntries(
    environment.map((item) => {
      const eq = item.indexOf("=");
      return eq < 0 ? [item, ""] : [item.slice(0, eq), item.slice(eq + 1)];
    }),
  );
}

// `name:/target[:mode]` or a long-form bind object.
function volumeTarget(volume: string | VolumeObject): string | undefined {
  return typeof volume === "string" ? volume.split(":")[1] : volume.target;
}

const base = (() => {
  const compose = parse(readText(composePath)) as ComposeFile;
  const service = compose.services?.[serviceName];
  const env = envOf(service?.environment);
  return {
    image: service?.image,
    env: {
      OBSIDIAN_TC_CONFIG: env.OBSIDIAN_TC_CONFIG,
      OBSIDIAN_TC_VAULT_PATH: env.OBSIDIAN_TC_VAULT_PATH,
      OBSIDIAN_TC_CACHE_DIR: env.OBSIDIAN_TC_CACHE_DIR,
      PORT: /^\$\{PORT:-(\d+)\}$/.exec(env.PORT ?? "")?.[1],
    },
    volumeTargets: (service?.volumes ?? []).map(volumeTarget),
    port: Number(/^\$\{PORT:-(\d+)\}$/.exec(env.PORT ?? "")?.[1]),
    sharedConfig: JSON.parse(readText(sharedConfigPath)) as unknown,
  };
})();

function loadCoolify(): Normalized {
  const doc = parse(readText(join(paasRoot, "coolify/obsidian-tc.yaml"))) as ComposeFile;
  const service = doc.services?.[serviceName];
  const env = envOf(service?.environment);
  const routed = Object.keys(env)
    .map((key) => /^SERVICE_URL_OBSIDIAN_TC_(\d+)$/.exec(key)?.[1])
    .find((port) => port !== undefined);
  const configVolume = (service?.volumes ?? []).find(
    (volume): volume is VolumeObject =>
      typeof volume === "object" && volume.target === configTarget,
  );
  return {
    image: service?.image,
    env,
    volumeTargets: (service?.volumes ?? []).map(volumeTarget).filter((t) => t !== undefined),
    configJson: configVolume?.content === undefined ? undefined : JSON.parse(configVolume.content),
    httpPort: Number(routed),
    healthcheck: service?.healthcheck,
  };
}

function loadDokploy(): Normalized {
  const dir = join(paasRoot, "dokploy");
  const compose = parse(readText(join(dir, "docker-compose.yml"))) as ComposeFile;
  const toml = readText(join(dir, "template.toml"));
  const service = compose.services?.[serviceName];
  const tomlEnv = envOf(
    [...(/^env = \[([\s\S]*?)\]/m.exec(toml)?.[1] ?? "").matchAll(/"([^"]*)"/g)].map(
      (m) => m[1] ?? "",
    ),
  );
  const mount = /\[\[config\.mounts\]\]\s*filePath = "([^"]+)"\s*content = """\n([\s\S]*?)"""/.exec(
    toml,
  );
  const domain = /\[\[config\.domains\]\]\s*serviceName = "([^"]+)"\s*port = (\d+)/.exec(toml);
  const bind = (service?.volumes ?? []).find(
    (volume): volume is string =>
      typeof volume === "string" && volumeTarget(volume) === configTarget,
  );
  const bindSource = bind?.split(":")[0];
  return {
    image: service?.image,
    env: { ...envOf(service?.environment), ...tomlEnv },
    volumeTargets: (service?.volumes ?? []).map(volumeTarget).filter((t) => t !== undefined),
    configJson:
      mount && bindSource === `../files/${mount[1] ?? ""}` ? JSON.parse(mount[2] ?? "") : undefined,
    httpPort: Number(domain?.[2]),
    healthcheck: service?.healthcheck,
  };
}

function loadCaprover(): Normalized {
  interface CaproverService extends ComposeService {
    caproverExtra?: { containerHttpPort?: string; dockerfileLines?: string[] };
  }
  const doc = parse(readText(join(paasRoot, "caprover/obsidian-tc.yml"))) as {
    services?: Record<string, CaproverService>;
    caproverOneClickApp?: { variables?: Array<{ id: string; defaultValue?: string }> };
  };
  const service = doc.services?.$$cap_appname;
  const lines = service?.caproverExtra?.dockerfileLines ?? [];
  const fromRef = /^FROM (\S+):(\$\$cap_\w+)$/.exec(lines.find((l) => l.startsWith("FROM ")) ?? "");
  const tagVariable = doc.caproverOneClickApp?.variables?.find((v) => v.id === fromRef?.[2]);
  const runLine = lines.find((l) => l.startsWith("RUN ")) ?? "";
  const json = /'(\{.*\})'/.exec(runLine)?.[1];
  return {
    image:
      fromRef && tagVariable?.defaultValue !== undefined
        ? `${fromRef[1]}:${tagVariable.defaultValue}`
        : undefined,
    env: envOf(service?.environment),
    volumeTargets: (service?.volumes ?? []).map(volumeTarget).filter((t) => t !== undefined),
    configJson: json === undefined ? undefined : JSON.parse(json),
    httpPort: Number(service?.caproverExtra?.containerHttpPort),
    healthcheck: service?.healthcheck,
  };
}

const templates = [
  { name: "coolify", load: loadCoolify },
  { name: "dokploy", load: loadDokploy },
  { name: "caprover", load: loadCaprover },
];

describe("deploy/paas templates", () => {
  it("holds exactly the three platform directories, so a new platform needs a table row", () => {
    const dirs = readdirSync(paasRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirs).toEqual(["caprover", "coolify", "dokploy"]);
  });

  it("reads a real base image, config env and port from compose.http.yml", () => {
    expect(base.image).toMatch(/^ghcr\.io\/the-40-thieves\/obsidian-tc:/);
    expect(base.port).toBe(8765);
    expect(base.env.OBSIDIAN_TC_CONFIG).toBe(configTarget);
    expect(base.volumeTargets).toContain("/data");
  });

  it.each(templates)("$name: runs the image compose.http.yml runs", ({ load }) => {
    expect(load().image).toBe(base.image);
  });

  it.each(templates)(
    "$name: sets the config, vault, cache and port env like compose.http.yml",
    ({ load }) => {
      const { env } = load();
      expect(env.OBSIDIAN_TC_CONFIG).toBe(base.env.OBSIDIAN_TC_CONFIG);
      expect(env.OBSIDIAN_TC_VAULT_PATH).toBe(base.env.OBSIDIAN_TC_VAULT_PATH);
      expect(env.OBSIDIAN_TC_CACHE_DIR).toBe(base.env.OBSIDIAN_TC_CACHE_DIR);
      expect(env.PORT).toBe(String(base.port));
    },
  );

  it.each(templates)("$name: mounts a volume at /data", ({ load }) => {
    expect(load().volumeTargets).toContain("/data");
  });

  it.each(templates)("$name: delivers the shared config JSON at the config path", ({ load }) => {
    expect(load().configJson).toEqual(base.sharedConfig);
  });

  it.each(templates)("$name: routes container port 8765", ({ load }) => {
    expect(load().httpPort).toBe(base.port);
  });

  it.each(templates)("$name: sets no healthcheck, inheriting the image HEALTHCHECK", ({ load }) => {
    expect(load().healthcheck).toBeUndefined();
  });

  it.each(templates)("$name: never hard-codes the JWT secret", ({ load }) => {
    expect(load().env.OBSIDIAN_TC_JWT_SECRET).toMatch(/^\$[{$]/);
  });

  it("the image HEALTHCHECK probes /healthz and EXPOSE 8765 is declared", () => {
    const dockerfile = readText(dockerfilePath);
    expect(dockerfile).toMatch(/^HEALTHCHECK .*\/healthz/m);
    expect(dockerfile).toMatch(/^EXPOSE 8765$/m);
  });
});

describe("Coolify template", () => {
  const path = join(paasRoot, "coolify/obsidian-tc.yaml");

  it("declares the routed port in the header and as a SERVICE_URL magic variable", () => {
    expect(readText(path)).toMatch(/^# port: 8765$/m);
    expect(loadCoolify().env).toHaveProperty("SERVICE_URL_OBSIDIAN_TC_8765");
  });

  it("starts with the documentation header Coolify reads", () => {
    expect(readText(path).split("\n")[0]).toMatch(/^# documentation: /);
  });

  it("takes the public URL and the 64-char JWT secret from Coolify magic variables", () => {
    const { env } = loadCoolify();
    expect(env.OBSIDIAN_TC_PUBLIC_URL).toBe(`\${SERVICE_URL_OBSIDIAN_TC}`);
    expect(env.OBSIDIAN_TC_JWT_SECRET).toBe(`\${SERVICE_PASSWORD_64_OBSIDIANTC}`);
  });

  it("omits container_name, ports and restart", () => {
    const doc = parse(readText(path)) as { services: Record<string, ComposeService> };
    const service = doc.services[serviceName];
    expect(service).not.toHaveProperty("container_name");
    expect(service).not.toHaveProperty("ports");
    expect(service).not.toHaveProperty("restart");
  });
});

describe("Dokploy template", () => {
  const dir = join(paasRoot, "dokploy");

  it("takes the public URL from the generated domain and the secret from a 64-char password", () => {
    const toml = readText(join(dir, "template.toml"));
    expect(toml).toMatch(/^main_domain = "\$\{domain\}"$/m);
    expect(loadDokploy().env.OBSIDIAN_TC_PUBLIC_URL).toBe(`https://\${main_domain}`);
    expect(toml).toMatch(/^jwt_secret = "\$\{password:64\}"$/m);
    expect(loadDokploy().env.OBSIDIAN_TC_JWT_SECRET).toBe(`\${jwt_secret}`);
  });

  it("routes the domain to the compose service key", () => {
    const toml = readText(join(dir, "template.toml"));
    expect(toml).toMatch(new RegExp(`serviceName = "${serviceName}"`));
  });

  it("omits ports, container_name and networks", () => {
    const doc = parse(readText(join(dir, "docker-compose.yml"))) as {
      services: Record<string, ComposeService>;
    };
    const service = doc.services[serviceName];
    expect(service).not.toHaveProperty("ports");
    expect(service).not.toHaveProperty("container_name");
    expect(service).not.toHaveProperty("networks");
  });

  it("meta.json names the blueprint folder and pins the image tag as its version", () => {
    const meta = JSON.parse(readText(join(dir, "meta.json"))) as { id: string; version: string };
    expect(meta.id).toBe("obsidian-tc");
    expect(meta.version).toBe(base.image?.split(":").at(-1));
  });
});

describe("CapRover template", () => {
  const path = join(paasRoot, "caprover/obsidian-tc.yml");

  it("starts with captainVersion 4", () => {
    expect(Object.keys(parse(readText(path)) as object)[0]).toBe("captainVersion");
    expect((parse(readText(path)) as { captainVersion: unknown }).captainVersion).toBe(4);
  });

  it("builds the image FROM the pinned tag variable, defaulting to the base tag", () => {
    const doc = parse(readText(path)) as {
      caproverOneClickApp: { variables: Array<{ id: string; defaultValue?: string }> };
    };
    const variable = doc.caproverOneClickApp.variables.find(
      (v) => v.id === "$$cap_obsidian_tc_version",
    );
    expect(variable?.defaultValue).toBe(base.image?.split(":").at(-1));
    expect(readText(path)).toMatch(
      /^ {16}- FROM ghcr\.io\/the-40-thieves\/obsidian-tc:\$\$cap_obsidian_tc_version$/m,
    );
  });

  it("has no image key on the service, because dockerfileLines replaces it", () => {
    const doc = parse(readText(path)) as { services: Record<string, ComposeService> };
    expect(doc.services.$$cap_appname).not.toHaveProperty("image");
  });

  it("takes the public URL from the app domain and the secret from a generated hex value", () => {
    const { env } = loadCaprover();
    expect(env.OBSIDIAN_TC_PUBLIC_URL).toBe("https://$$cap_appname.$$cap_root_domain");
    expect(env.OBSIDIAN_TC_JWT_SECRET).toBe("$$cap_jwt_secret");
    const doc = parse(readText(path)) as {
      caproverOneClickApp: { variables: Array<{ id: string; defaultValue?: string }> };
    };
    const secret = doc.caproverOneClickApp.variables.find((v) => v.id === "$$cap_jwt_secret");
    expect(secret?.defaultValue).toMatch(/^\$\$cap_gen_random_hex\((\d+)\)$/);
  });

  it("ends the Dockerfile lines as the non-root bun user, like the runtime stage", () => {
    const doc = parse(readText(path)) as {
      services: Record<string, { caproverExtra: { dockerfileLines: string[] } }>;
    };
    const lines = doc.services.$$cap_appname?.caproverExtra.dockerfileLines ?? [];
    expect(lines.at(-1)).toBe("USER bun");
  });

  it("keeps the one-click description within 200 characters", () => {
    const doc = parse(readText(path)) as {
      caproverOneClickApp: { description: string };
    };
    expect(doc.caproverOneClickApp.description.length).toBeLessThanOrEqual(200);
  });
});
