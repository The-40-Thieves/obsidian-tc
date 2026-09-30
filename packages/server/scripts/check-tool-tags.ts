// CI gate: `bun scripts/check-tool-tags.ts` — every registered tool carries tags from the
// vocabulary in src/mcp/tool-tags.ts. Registration already throws on a bad declaration; this
// audits the assembled production registry, so a tool that reaches it any other way, a vocabulary
// entry nothing uses, or a derivation regression fails the build by name.
import { buildFullRegistry } from "./docgen/build-registry";
import { checkToolTags } from "./docgen/check-tool-tags";

const tools = buildFullRegistry().list();
const problems = checkToolTags(tools);
if (problems.length > 0) {
  process.stderr.write(`tool-tags: ${problems.length} problem(s)\n`);
  for (const p of problems) process.stderr.write(`  ${p}\n`);
  process.exit(1);
}
process.stdout.write(`tool-tags: clean (${tools.length} tools)\n`);
