// The repo-root railway.json. Railway reads it at deploy time and silently ignores a misspelled
// field, so these assertions pin the fields the Railway deployment page names.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface RailwayConfig {
  $schema?: string;
  build?: { builder?: string };
  deploy?: { healthcheckPath?: string; restartPolicyType?: string; startCommand?: string };
}

const railway = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../railway.json", import.meta.url)), "utf8"),
) as RailwayConfig;

describe("railway.json", () => {
  it("names the Railway schema and builds from the repo Dockerfile", () => {
    expect(railway.$schema).toBe("https://railway.com/railway.schema.json");
    expect(railway.build?.builder).toBe("DOCKERFILE");
  });

  it("restarts only on failure", () => {
    expect(railway.deploy?.restartPolicyType).toBe("ON_FAILURE");
  });

  it("sets no startCommand: the image ENTRYPOINT already serves HTTP from OBSIDIAN_TC_CONFIG", () => {
    expect(railway.deploy?.startCommand).toBeUndefined();
  });

  it("uses the unauthenticated liveness route for health checks", () => {
    expect(railway.deploy?.healthcheckPath).toBe("/healthz");
  });
});
