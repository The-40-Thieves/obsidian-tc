// deploy/cloud-init.yaml, the VPS user data. Its embedded compose and config must stay byte-identical
// to the shared files, the secret must be generated on the server and never printed, and the Caddy
// port must match the loopback bind. `cloud-init schema` runs as a local gate, not from this test, so
// CI runners need no cloud-init binary.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

const cloudInitText = read("deploy/cloud-init.yaml");
const doc = YAML.parse(cloudInitText) as {
  packages?: string[];
  write_files?: { path: string; permissions?: string; content: string }[];
  runcmd?: unknown[];
};

const file = (pathSuffix: string) => {
  const entry = doc.write_files?.find((f) => f.path.endsWith(pathSuffix));
  expect(entry, `write_files entry ending ${pathSuffix}`).toBeDefined();
  return entry as { path: string; permissions?: string; content: string };
};

describe("deploy/cloud-init.yaml", () => {
  it("starts with the cloud-config marker", () => {
    expect(cloudInitText.split("\n")[0]).toBe("#cloud-config");
  });

  it("writes the shared compose file byte-for-byte", () => {
    expect(file("/deploy/compose.http.yml").content).toBe(read("deploy/compose.http.yml"));
  });

  it("writes the shared HTTP config byte-for-byte", () => {
    expect(file("/deploy/config/obsidian-tc.config.json").content).toBe(
      read("deploy/config/obsidian-tc.config.json"),
    );
  });

  it("writes .env root-only and without a secret: the secret is generated on the server", () => {
    const env = file("/deploy/.env");
    expect(env.permissions).toBe("0600");
    expect(env.content).toContain("OBSIDIAN_TC_PUBLIC_URL=");
    expect(env.content).not.toContain("OBSIDIAN_TC_JWT_SECRET");
  });

  it("binds the published port to loopback in the VPS override, with !override", () => {
    const override = file("/deploy/compose.vps.yml").content;
    expect(override).toContain("ports: !override");
    expect(override).toContain('"127.0.0.1:8765:8765"');
  });

  it("generates the secret in an executable bootstrap script and never prints it", () => {
    const script = file("/opt/obsidian-tc/bootstrap.sh");
    expect(script.permissions).toBe("0755");
    expect(script.content.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script.content).toContain("openssl rand -hex 32");
    expect(script.content).toContain("reverse_proxy 127.0.0.1:8765");
    expect(script.content).toContain("-f compose.http.yml -f compose.vps.yml up -d");
    for (const line of script.content.split("\n")) {
      if (!line.includes("OBSIDIAN_TC_JWT_SECRET")) continue;
      expect(line.includes(">> .env") || line.includes("grep -q"), line).toBe(true);
    }
  });

  it("installs Docker, Compose and Caddy from the Ubuntu archive", () => {
    expect(doc.packages).toEqual(
      expect.arrayContaining(["docker.io", "docker-compose-v2", "caddy"]),
    );
  });

  it("runs the bootstrap script from runcmd", () => {
    expect(doc.runcmd).toEqual([["/opt/obsidian-tc/bootstrap.sh"]]);
  });
});
