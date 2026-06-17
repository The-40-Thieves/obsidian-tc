// Copy runtime SQL assets next to the bundled bin so dist/cli.js resolves them
// the same way it does from source (via new URL("./migrations/...", import.meta.url)).
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
cpSync(join(root, "src", "migrations"), join(dist, "migrations"), { recursive: true });
cpSync(join(root, "src", "schema.sql"), join(dist, "schema.sql"));
console.log("copied SQL assets -> dist/");
