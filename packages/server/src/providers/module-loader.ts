// The escape hatch. A config that names code to import is a real capability, gated on the SAME
// securityProfile the rest of the server uses rather than a second trust axis that could disagree.
// hardened refuses; trusted-local allows — config.json already holds vault paths, API keys and the
// JWT secret, so whoever can write it already owns this process.
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { err } from "@the-40-thieves/obsidian-tc-shared";

export interface LoadProviderModuleOpts {
  modulePath: string;
  configDir: string | undefined;
  securityProfile: "hardened" | "trusted-local" | undefined;
  exportName: "createEmbeddingProvider" | "createReranker";
  slot: "embeddings" | "reranker";
}

function assertUsable(value: unknown, opts: LoadProviderModuleOpts): void {
  if (opts.slot === "reranker") {
    if (typeof value !== "function") {
      throw err.invalidInput(`${opts.slot}.modulePath did not produce a Reranker function`, {
        modulePath: opts.modulePath,
        hint: "createReranker must return (query, documents, topN) => Promise<RerankHit[]>",
      });
    }
    return;
  }
  const p = value as { embed?: unknown; dimensions?: unknown };
  const dimsOk =
    typeof p?.dimensions === "number" && Number.isInteger(p.dimensions) && p.dimensions > 0;
  if (typeof p?.embed !== "function" || !dimsOk) {
    throw err.invalidInput(`${opts.slot}.modulePath did not produce a usable EmbeddingProvider`, {
      modulePath: opts.modulePath,
      hint: "createEmbeddingProvider must return an object with embed(texts) and a positive integer dimensions",
    });
  }
}

export async function loadProviderModule<T>(opts: LoadProviderModuleOpts): Promise<T> {
  if (!opts.modulePath || opts.modulePath.length === 0) {
    throw err.invalidInput(
      `${opts.slot}.provider is "module" but ${opts.slot}.modulePath is not set`,
      {
        hint: `set ${opts.slot}.modulePath to a module exporting ${opts.exportName}`,
      },
    );
  }
  const profile = opts.securityProfile ?? "trusted-local";
  if (profile === "hardened") {
    throw err.invalidInput(
      `${opts.slot}.provider "module" is refused under securityProfile "hardened"`,
      {
        modulePath: opts.modulePath,
        hint: `loading a provider module executes code named by config.json. Use a declarative provider (e.g. openai-compatible) under the hardened posture.`,
      },
    );
  }
  if (!opts.configDir && !isAbsolute(opts.modulePath)) {
    throw err.invalidInput(
      `${opts.slot}.modulePath is relative but there is no config file directory to resolve it against`,
      {
        modulePath: opts.modulePath,
        hint: "a relative modulePath resolves against the config file's directory; this server started without a config file, so give an absolute path.",
      },
    );
  }
  // The config DIRECTORY is the trust root, never process.cwd() — cwd in a container is arbitrary.
  const abs = isAbsolute(opts.modulePath)
    ? opts.modulePath
    : resolve(opts.configDir as string, opts.modulePath);

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  } catch (cause) {
    throw err.invalidInput(`${opts.slot}.modulePath could not be imported`, {
      modulePath: opts.modulePath,
      resolved: abs,
      hint: `${(cause as Error).message}`,
    });
  }
  const factory = mod[opts.exportName];
  if (typeof factory !== "function") {
    throw err.invalidInput(`${opts.slot}.modulePath does not export ${opts.exportName}`, {
      modulePath: opts.modulePath,
      resolved: abs,
      hint: `export a function named ${opts.exportName} from that module`,
    });
  }
  const built = (factory as () => unknown)();
  assertUsable(built, opts);
  return built as T;
}
