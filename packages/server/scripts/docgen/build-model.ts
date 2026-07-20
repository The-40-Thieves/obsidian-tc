// docgen — assemble the DocsModel and print it as JSON (THE-471). Deterministic (no timestamp) so the
// drift gate (THE-476) can `git diff --exit-code` the committed model.
//
//   bun scripts/docgen/build-model.ts > docs-model.json
import { extractConfig } from "./extract-config";
import { extractErrors } from "./extract-errors";
import { extractMetrics } from "./extract-metrics";
import { extractSchema } from "./extract-schema";
import { extractTools } from "./extract-tools";
import { emptyModel } from "./model";

const model = {
  ...emptyModel(),
  config: extractConfig(),
  tools: extractTools(),
  metrics: await extractMetrics(),
  errors: extractErrors(),
  tables: await extractSchema(),
};
process.stdout.write(`${JSON.stringify(model, null, 2)}\n`);
