import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
// Loaded at runtime so Vite never statically resolves the (newish) node:sqlite builtin.
export function openMemoryDb(): any {
  const { DatabaseSync } = req("node:sqlite");
  return new DatabaseSync(":memory:");
}
