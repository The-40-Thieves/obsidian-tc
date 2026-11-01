// Fix round (LOW 5): the embedder child under bun, with an embed that calls console.dir and
// console.table. The child-main test runs it and asserts stdout carries only protocol lines.
import { runEmbedderChild } from "../../src/embeddings/host/child-main";

await runEmbedderChild({ input: process.stdin, output: process.stdout }, async () => ({
  embed: async (texts: string[]) => {
    console.dir({ nested: { deep: true } });
    console.table([{ col: 1 }]);
    return texts.map((text) => [text.length]);
  },
}));
