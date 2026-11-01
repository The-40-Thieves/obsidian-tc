// Fix round (HIGH 1): a one-shot CLI command embeds once through the child-process host and never
// calls close(). The process must exit on its own once the answer is printed. Run under bun by
// embedder-host-child-process.test.ts; argv[2] is the fake child fixture.
import { createChildProcessHost } from "../../src/embeddings/host/child-process";
import { markCliEntry } from "../../src/embeddings/host/spawn-argv";

markCliEntry();
const host = createChildProcessHost({
  argv: [process.execPath, process.argv[2] as string],
  init: { model: "fake", quantized: true, modelsRoot: "/unused", cacheDir: "/unused" },
});
console.log(JSON.stringify(await host.embed(["abc"])));
