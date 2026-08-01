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
  /** THE-677: the registry's built-in names for this slot, so a module cannot claim one of them.
   *
   *  INJECTED rather than imported: registry.ts imports this module, so importing it back would be
   *  a cycle and `check:boundaries` rejects those, type-only edges included. The caller already
   *  holds the list.
   *
   *  Empty or omitted disables the check — which is correct for a direct unit test of the loader,
   *  and is why both production call sites pass it explicitly. */
  reservedProviderNames?: readonly string[];
}

// Review finding 1: the original check covered only `embed` and `dimensions`, so a module
// returning `{ dimensions: 768, embed }` loaded fine with `id`/`provider`/`model` all `undefined`.
// `withRevision` (embeddings/index.ts) derives the vec fingerprint's identity from `provider.id`,
// so two DIFFERENT module providers at the same width produced an IDENTICAL fingerprint — no
// vec_chunks rebuild on a provider swap, and retrieval scoring new-provider queries against
// old-provider vectors. Exactly the bug class Task 6 closed by folding `revision` in. Validating
// all five fields here, at load time, is also what makes this refusal's own promise true:
// chunk_embeddings.model is bound from provider.id and is `TEXT NOT NULL`, so an unchecked id/model
// would have surfaced as a write-time DB error instead of a boot-time refusal.
function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
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
  const p = value as {
    id?: unknown;
    provider?: unknown;
    model?: unknown;
    embed?: unknown;
    dimensions?: unknown;
  };
  const dimsOk =
    typeof p?.dimensions === "number" && Number.isInteger(p.dimensions) && p.dimensions > 0;
  const idOk = nonEmptyString(p?.id);
  const providerOk = nonEmptyString(p?.provider);
  const modelOk = nonEmptyString(p?.model);
  const embedOk = typeof p?.embed === "function";
  if (!idOk || !providerOk || !modelOk || !dimsOk || !embedOk) {
    const missing = [
      !idOk && "id",
      !providerOk && "provider",
      !modelOk && "model",
      !dimsOk && "dimensions",
      !embedOk && "embed",
    ].filter((x): x is string => x !== false);
    throw err.invalidInput(`${opts.slot}.modulePath did not produce a usable EmbeddingProvider`, {
      modulePath: opts.modulePath,
      missing,
      hint:
        "createEmbeddingProvider must return an object with a non-empty string id, provider, and " +
        "model (id is what chunk_embeddings.model and vec_index_fingerprint store — two providers " +
        "sharing an id or leaving it undefined are indistinguishable to the index), a positive " +
        `integer dimensions, and embed(texts). Missing: ${missing.join(", ")}.`,
    });
  }
  assertIdentityNotImpersonated(p.provider as string, p.id as string, opts);
}

/**
 * THE-677: refuse a module that claims a built-in's identity.
 *
 * `chunk_embeddings.model` and `vec_chunks.model` store `provider.id`, and `vecFingerprint()` folds
 * `provider` and `model`. So a module returning `{ id: "ollama:bge-m3", provider: "ollama", model:
 * "bge-m3" }` is byte-indistinguishable from the built-in `ollama` provider in BOTH. Swap one for
 * the other and the fingerprint does not move, so `ensureVecChunks` does not rebuild and
 * `note-plan.ts`'s re-embed gate does not fire — retrieval then scores queries embedded by one
 * model against vectors produced by a different one, silently, with no rebuild event and no log.
 *
 * That is the class THE-460 closed for same-dimension model swaps, reachable again through the
 * module hatch. Refusing at boot is the only place it can be caught: by the time the wrong vectors
 * are being served, nothing distinguishes them from the right ones.
 *
 * Both fields are checked. Gating `provider` alone is not enough — a module can declare
 * `provider: "mine"` and still set `id: "ollama:bge-m3"`, and `id` is the field the index stores.
 */
function assertIdentityNotImpersonated(
  provider: string,
  id: string,
  opts: LoadProviderModuleOpts,
): void {
  const reserved = opts.reservedProviderNames ?? [];
  if (reserved.length === 0) return;
  const claimed = reserved.find((n) => n === provider || id.startsWith(`${n}:`));
  if (claimed === undefined) return;
  throw err.invalidInput(
    `${opts.slot}.modulePath returned a provider that impersonates the built-in "${claimed}"`,
    {
      modulePath: opts.modulePath,
      claimed,
      providerReturned: provider,
      idReturned: id,
      hint:
        `a module provider must not report provider "${claimed}" or an id beginning "${claimed}:" — ` +
        "those are what chunk_embeddings.model and the vec fingerprint store, so an index built by " +
        `the built-in "${claimed}" and one built by this module would be indistinguishable, and ` +
        "swapping between them would serve stale vectors with no rebuild. Use an identity of your " +
        'own (e.g. provider "my-provider", id "my-provider:<model>").',
    },
  );
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
  // The config file's DIRECTORY is the trust root, not process.cwd() directly — cwd in a container
  // is arbitrary. Review round 2 (Minor 5): this is resolution against `configDir`, not immunity
  // from cwd altogether — if the config path itself was given relative to cwd (e.g. `--config
  // cfg.json`), `dirname("cfg.json")` is `"."`, and resolution here IS effectively cwd-relative.
  // Passing an absolute --config path is what makes this guarantee real; nothing here enforces that.
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
  // Minor 3 (review round 2): `await` on a plain (non-Promise) return value is a no-op, so this
  // supports BOTH an async factory (the natural shape for a provider that needs to connect/probe
  // before it is usable) and a sync one — before this fix, an `async function createEmbeddingProvider`
  // resolved to a Promise object here, which then failed assertUsable with a misleading "did not
  // produce a usable EmbeddingProvider" instead of actually running the factory.
  const built = await (factory as () => unknown)();
  assertUsable(built, opts);
  return built as T;
}
