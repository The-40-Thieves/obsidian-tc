// docgen — assemble the DocsModel and print it as JSON (THE-471). Deterministic (no timestamp) so the
// drift gate (THE-476) can `git diff --exit-code` the committed model. Extractors are added here as
// they land; today it carries the config slice.
//
//   bun scripts/docgen/build-model.ts > docs-model.json
import { extractConfig } from "./extract-config";
import { emptyModel } from "./model";

const model = { ...emptyModel(), config: extractConfig() };
process.stdout.write(`${JSON.stringify(model, null, 2)}\n`);
