// The repo-root render.yaml Blueprint. Render reads it when a deploy is created from the Deploy to
// Render button, and a misspelled key is ignored, so these assertions pin the fields the Render
// deployment page names.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

interface RenderEnvVar {
  key: string;
  value?: string;
  sync?: boolean;
  generateValue?: boolean;
}

interface RenderService {
  type: string;
  name?: string;
  runtime?: string;
  image?: { url?: string };
  plan?: string;
  healthCheckPath?: string;
  disk?: { name?: string; mountPath?: string; sizeGB?: number };
  envVars?: RenderEnvVar[];
}

interface RenderBlueprint {
  services?: RenderService[];
}

const blueprint = YAML.parse(
  readFileSync(fileURLToPath(new URL("../../../render.yaml", import.meta.url)), "utf8"),
) as RenderBlueprint;

const services = blueprint.services ?? [];
const web = services.find((s) => s.type === "web");
const env = (key: string): RenderEnvVar | undefined => web?.envVars?.find((v) => v.key === key);

describe("render.yaml", () => {
  it("declares one web service, pulled from the published ghcr image", () => {
    expect(services).toHaveLength(1);
    expect(web?.runtime).toBe("image");
    expect(web?.image?.url).toBe("ghcr.io/the-40-thieves/obsidian-tc:latest");
  });

  it("runs on the 2 GB Standard plan: a disk needs a paid plan and Starter (512 MB) is too small", () => {
    expect(web?.plan).toBe("1c-2g");
  });

  it("mounts the persistent disk at /data", () => {
    expect(web?.disk?.mountPath).toBe("/data");
    expect(web?.disk?.name).toBeTruthy();
    expect(web?.disk?.sizeGB).toBeGreaterThan(0);
  });

  it("uses the unauthenticated liveness route for health checks", () => {
    expect(web?.healthCheckPath).toBe("/healthz");
  });

  it("prompts for the public URL instead of guessing it", () => {
    expect(env("OBSIDIAN_TC_PUBLIC_URL")?.sync).toBe(false);
  });

  it("generates the one-time authorization server setup token", () => {
    expect(env("OBSIDIAN_TC_AS_SETUP_TOKEN")?.generateValue).toBe(true);
  });

  it("points the config file at the volume", () => {
    expect(env("OBSIDIAN_TC_CONFIG")?.value).toBe("/data/config.json");
  });

  it("prompts for the embeddings key rather than storing it in the file", () => {
    expect(env("OPENAI_API_KEY")?.sync).toBe(false);
    expect(env("OPENAI_API_KEY")?.value).toBeUndefined();
  });
});
