# Vendor runtime and model licensing

> **Not legal advice.** This is an engineering inventory of the licence terms we could read, with
> the date each one was checked. Items marked ⚠ need counsel before anything ships. Items marked
> UNVERIFIED were not read from a primary source in this pass and must not be relied on.

Context: obsidian-tc is AGPL-3.0-only ([LICENSE](../LICENSE);
[plain-language FAQ](src/content/docs/licensing.md)). A planned clean-room engine would be
Apache-2.0. Before any deferred vendor inference runtime ships, bundled or fetched, each artifact
needs a row here.

All "checked" dates are **2026-10-19** unless a row says otherwise. Sources are the vendor's own
licence or EULA, the package's own LICENSE file, or the model card. Where a source was reached only
through a search snippet, the row says so.

## 1. Component table

Verdict key: **OK** (terms read, no ⚠), **⚠** (counsel), **UNVERIFIED** (not read from the primary
source).

| Component | Licence (checked) | Bundle? | Runtime fetch? | User-installed only? | AGPL notes | Attribution | Verdict |
|---|---|---|---|---|---|---|---|
| Microsoft Foundry Local SDK `foundry-local-sdk` 2.1.0 | MIT ([LICENSE in npm tarball](https://www.npmjs.com/package/foundry-local-sdk)) | Permitted: "…to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software" | Permitted | No | MIT is GPL-compatible | Copyright notice and permission notice in copies | OK (not shipping) |
| Microsoft Foundry Local CLI and runtime | [Foundry Local License Terms](https://raw.githubusercontent.com/microsoft/Foundry-Local/main/LICENSE) (checked 2026-10-19; only the first sections read) | Restricted: the CLI may not "provide the software as a stand-alone offering or combine it with any of your applications for others to use" | Not verified | Install is by the user; "You may install and use any number of copies" | Bundling into an AGPL artifact conflicts with the quoted restriction on combining | Not verified | ⚠ |
| NVIDIA TensorRT-RTX | [NVIDIA TensorRT RTX License (21Apr2025)](https://developer.download.nvidia.com/licenses/NVIDIA_TensorRT_RTX_License_(21Apr2025).pdf). PDF text was not readable; only search snippets read. Snippet: "Unless a developer tool is identified in this Agreement as distributable, it is delivered for your internal use only." | Only if the agreement names it distributable: UNVERIFIED | Not verified | Likely yes | Snippet: the software is licensed "only for use in systems with NVIDIA GPU" | Not verified | ⚠ UNVERIFIED |
| NVIDIA CUDA runtime redistributables | [CUDA EULA v13.4, Section 2.6 / Attachment A](https://docs.nvidia.com/cuda/eula/index.html) (last updated 2026-01-26 per header; the footer says Oct 12, 2026, so the version date is unclear). Attachment A says files "may be distributed with applications developed by you." | Yes, for files listed in Attachment A, subject to conditions not confirmed here (see gaps) | Not verified | Otherwise yes | Redistribution conditions (private directory, customer flow-down) were NOT found on the page read; they appear in older EULA versions only | Not verified | ⚠ |
| NVIDIA cuDNN | [cuDNN SLA](https://docs.nvidia.com/deeplearning/cudnn/) not read; search snippet says the SLA "describes that we can redistribute DLLs with our application" (UNVERIFIED) | UNVERIFIED | Not verified | Not verified | Not verified | Not verified | UNVERIFIED |
| NVIDIA NIM, self-hosted container | [NGC Model-Free NIM listing](https://catalog.ngc.nvidia.com/orgs/nim/nvidia/containers/model-free-nim/3.0.0) (snippet): "governed by the NVIDIA Software License Agreement and the Product-Specific Terms for NVIDIA AI Products"; models under the NVIDIA Open Model Agreement | Container: not verified | Not verified | Container is pulled from NGC by the user | Not verified | Not verified | ⚠ UNVERIFIED |
| NVIDIA NIM, hosted API (build.nvidia.com) | Terms NOT found | n/a | n/a | n/a | n/a | n/a | UNVERIFIED |
| Windows App SDK / Windows ML | [WindowsAppSDK LICENSE](https://github.com/microsoft/WindowsAppSDK/blob/main/LICENSE): MIT, "Copyright (c) Microsoft Corporation". Windows ML runtime terms NOT read. | Not verified for the Windows ML runtime | Not verified | Not verified | MIT for the SDK | Copyright notice | OK for the SDK; UNVERIFIED for Windows ML |
| AMD MIGraphX and Vitis AI execution providers (via Windows ML) | Licence NOT found. Distribution is by Windows Update as separate packages (support-page snippet). | UNVERIFIED | Delivered by Windows Update | Yes, OS-delivered | Not verified | Not verified | UNVERIFIED |
| Intel OpenVINO runtime | [Apache-2.0](https://github.com/openvinotoolkit/openvino/blob/master/LICENSE) | Yes (Apache-2.0 §4) | Not verified | Not verified | Apache-2.0 is GPLv3-compatible per the FSF list (not re-read in this pass) | §4(d): a NOTICE file, if the work has one, must be carried. None was read. | OK (not shipping) |
| Intel OpenVINO GenAI, `openvino-genai-node` 2026.4.1 | Apache-2.0 ([package.json](https://www.npmjs.com/package/openvino-genai-node)). The npm tarball has NO LICENSE file. | Yes, with a licence copy (see gaps) | Not verified | Not verified | Same as OpenVINO | Carry a licence copy | OK licence; gap in tarball |
| `ort` Rust crate | MIT OR Apache-2.0 ([crates.io](https://crates.io/crates/ort)). Not a current dependency (`packages/native/Cargo.toml` depends on napi only). | Planned only | n/a | n/a | Dual licence, either choice works | Copyright notice for MIT | OK (not shipping) |
| onnxruntime (native libraries) | MIT, "Copyright (c) Microsoft Corporation": [repo copy](../packages/embedder-local/licenses/onnxruntime-LICENSE) | **Yes, shipped today** in the MCPB bundle and standalone binaries (see section 2) | No, the model is fetched, not the runtime | No | MIT is GPL-compatible | MIT requires the notice in "all copies or substantial portions" | ⚠ see gaps G2 |
| `onnxruntime-node` 1.30.0 (npm) | MIT ([npm metadata](https://www.npmjs.com/package/onnxruntime-node)). The tarball has NO LICENSE file. | Yes, today, through `@huggingface/transformers` | No | No | As above | As above | ⚠ see gaps G4 |
| `onnxruntime-web` 1.30.0 (WASM fallback) | MIT ([npm metadata](https://www.npmjs.com/package/onnxruntime-web)) | Yes, today, in the MCPB bundle and the `darwin-x64` runtime package | No | No | As above | As above | ⚠ see gaps G2 |
| `@huggingface/transformers` 4.3.1 | Apache-2.0, LICENSE in [npm tarball](https://www.npmjs.com/package/@huggingface/transformers) | Yes, today (bundled into the embedder) | No | No | Apache-2.0 is GPLv3-compatible per the FSF list | §4(d) NOTICE only if the work has one | OK |
| `sqlite-vec` 0.1.9 | MIT OR Apache-2.0 ([npm metadata](https://www.npmjs.com/package/sqlite-vec); [LICENSE-MIT on GitHub](https://github.com/asg017/sqlite-vec/blob/main/LICENSE-MIT): "Copyright (c) 2024 Alex Garcia"). The npm tarball has NO LICENSE file. | Yes, today: every platform package in the MCPB bundle (`scripts/lib/mcpb-staging.mjs`) and the Docker runtime | No | No | Dual licence, either choice works | MIT notice in copies | ⚠ see gaps G3 |
| `all-smi` 0.28.0 | Apache-2.0 ([crates.io](https://crates.io/crates/all-smi)). Only relevant if code is borrowed. Not in the repo. | No | n/a | n/a | Apache-2.0 | §4(d) | OK (not used) |
| Model: `nomic-embed-text-v1.5` (catalog default) | Apache-2.0 ([model card, checked 2026-10-19](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5)) | No: weights are not in any artifact | **Yes**: fetched from `huggingface.co` at runtime, checksum-verified (`packages/embedder-local/src/model-fetch.ts`) | Pre-fetch optional (`bun run fetch-model`) | Apache-2.0 | Carry the notice in any copy we redistribute | OK |
| Model: `all-MiniLM-L6-v2` (catalog) | Apache-2.0 ([model card](https://huggingface.co/Xenova/all-MiniLM-L6-v2)) | No | Yes, same path | Optional | Apache-2.0 | As above | OK |
| Model: `bge-small-en-v1.5` (catalog) | MIT per `packages/embedder-local/src/model-info.ts` (`license: "mit"`). The Xenova HF page was NOT read; UNVERIFIED for the mirror. | No | Yes, same path | Optional | MIT | Notice | OK (per recorded value) |
| Model: `bge-m3` (`services/bge-m3-service`, `BAAI/bge-m3`) | MIT ([model card, checked 2026-10-19](https://huggingface.co/BAAI/bge-m3)) | No | Yes, from the Hub by the service | Optional | MIT | Notice | OK |
| Model: `bge-reranker-v2-m3` (service default reranker) | Apache-2.0 ([model card](https://huggingface.co/BAAI/bge-reranker-v2-m3)) | No | Yes | Optional | Apache-2.0 | As above | OK |
| Model: reranker `Xenova/ms-marco-MiniLM-L-6-v2` (`packages/reranker-local`) | Recorded as Apache-2.0 in the model-info comment (upstream `cross-encoder/ms-marco-MiniLM-L6-v2`). The Xenova page was NOT read. | No | Yes | Optional | Apache-2.0 | As above | UNVERIFIED for the mirror |
| Model: `EmbeddingGemma-300M` (candidate, DROPPED) | Gemma Terms of Use, licence field `gemma` ([model card](https://huggingface.co/google/embeddinggemma-300m); [terms](https://ai.google.dev/gemma/terms), modified 2026-04-01) | Not in the repo | n/a | n/a | Not OSI-approved. §3.1 requires the §3.2 use restrictions in "any agreement" with recipients, and §3.2 incorporates the Gemma Prohibited Use Policy | Flow-down required | ⚠ (if reintroduced) |
| Model: `Qwen3-Embedding` (candidate) | Apache-2.0 for `Qwen/Qwen3-Embedding-0.6B` ([model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)); other sizes NOT checked | Not in the repo | n/a | n/a | Apache-2.0 | Notice | OK for 0.6B only |

## 2. Per-artifact table

"Ships today" means the artifact is produced by the repo as it stands. "Planned" means it appears
only in design or candidate lists.

| Artifact | Bundled (may ship in it) | Dynamically loaded or fetched | User-installed only | Ships today? |
|---|---|---|---|---|
| npm package (`obsidian-tc`; `@the-40-thieves/obsidian-tc-embedder-local` base plus six per-platform runtime packages, per `packages/embedder-local/README.md`) | Our AGPL code. Runtime packages carry ORT (MIT) and the WASM fallback (MIT). The base package bundles Transformers.js (Apache-2.0). | Models fetched from Hugging Face at first use (`model-fetch.ts`) | Foundry Local, NIM, TensorRT-RTX, CUDA: planned only | Yes (embedder pack per `scripts/pack-embedder-local.ts`) |
| Compiled `bun --compile` binaries (`scripts/build-binary.ts`) | Anything the build plugin embeds: ORT native library and binding, `sqlite-vec`. The plugin in `scripts/lib/embedder-bundle.mjs` rewrites the ORT loader. | Models fetched at runtime | As for npm | Yes, the script exists. No licence text in the binary was found in `build-binary.ts` (grep for "licen"/"notice" returned nothing). |
| MCPB bundle (`dist/obsidian-tc.mcpb`, `scripts/bundle-mcpb.ts`) | Server build, all `sqlite-vec` platform packages, ORT native libraries for each platform (`ORT_PLATFORMS`), `onnxruntime-web` WASM, `@huggingface/transformers` | Models fetched at runtime; not in the bundle | Nothing required | Yes |
| Docker image (`Dockerfile`) | `sqlite-vec` (`cp -rL` of its platform packages), `packages/embedder-local` (including `licenses/`), runtime `node_modules` | Models fetched at runtime. No model download step found in the Dockerfile. | Foundry Local, NIM, CUDA: planned only | Yes |
| Remote worker container (`services/bge-m3-service`, `services/qwen-tei`, `services/docs-ingest`) | Service code (repo licence). Image contents for the Python services were NOT inspected in this pass. | `BAAI/bge-m3` and `BAAI/bge-reranker-v2-m3` fetched from the Hub (`hub.py`) | NVIDIA GPU stack and CUDA: UNVERIFIED for what the image installs | Yes, as a service in the repo. Image licence contents UNVERIFIED. |

## 3. Gaps today

Facts only. Each gap names its evidence path. None of these is fixed in this change.

- **G1. No NOTICE or THIRD_PARTY file.** `fd -i "notice|third.party" -E node_modules` finds only source files
  with "notice" in the name (boot notices, a legacy notice module). There is no root NOTICE,
  THIRD_PARTY or ATTRIBUTION file. The only third-party licence text in a package is
  `packages/embedder-local/licenses/onnxruntime-LICENSE`. The corpus notices in
  `packages/server/eval/corpora/ATTRIBUTION.md` cover eval data that is not shipped.
- **G2. ORT and WASM licence text may not travel with the MCPB bundle or binaries.** The bundling
  scripts ship the ORT native libraries and WASM (`scripts/lib/embedder-bundle.mjs`,
  `ORT_PLATFORMS`, `ortWasmFiles`). A grep of `scripts/bundle-mcpb.ts`,
  `scripts/lib/mcpb-staging.mjs` and `scripts/lib/embedder-bundle.mjs` for `LICENSE`, `licenses/`
  and `notice` returned no matches. MIT requires the notice in copies or substantial portions. Whether
  the binaries satisfy this is UNVERIFIED: ORT's notice may be carried by a file this grep did not
  reach.
- **G3. `sqlite-vec` licence text is not in its npm tarball.** `npm pack sqlite-vec@0.1.9` contains
  `README.md`, `index.cjs`, `index.d.ts`, `index.mjs`, `package.json` and no LICENSE. The MCPB and
  Docker artifacts copy the platform packages whole (`scripts/lib/mcpb-staging.mjs:125`), so the
  notice is absent unless a platform package carries it. Platform packages were NOT inspected
  (UNVERIFIED).
- **G4. `onnxruntime-node` 1.30.0 npm tarball has no LICENSE file.** Contents: `README.md`, `bin`,
  `dist`, `lib`, `package.json`, `script`. Same notice question as G2 (UNVERIFIED for the bundled copy).
- **G5. Model licence flow-down is not disclosed to users in what we read.** Catalog licences are recorded
  in `packages/embedder-local/src/model-info.ts` (`license:` field) and in `docs/EVALUATION.md`
  (table at lines 341–345). No user-facing notice of model licences was found in the MCPB manifest
  (`mcpb/manifest.json`) or the in-product boot notices; this was grepped only by file name, not read
  end to end (UNVERIFIED).
- **G6. Models are fetched at runtime from `huggingface.co`.** `packages/embedder-local/src/model-fetch.ts:394`
  builds the URL and `ALLOWED_DOWNLOAD_HOST_SUFFIXES` (line 426) limits redirects to `huggingface.co`
  and `hf.co`. A fetched model is covered by its own licence (all current catalog entries are Apache-2.0
  or MIT). This is a fact about the download path, not a licence problem.
- **G7. EmbeddingGemma was dropped from the catalog for licence reasons.** `model-info.ts` header
  and `docs/EVALUATION.md:351` say the Gemma terms are not OSI-approved. There is no Gemma flow-down
  today. If it is reintroduced, the flow-down in section 1 applies.
- **G8. `openvino-genai-node` tarball has no LICENSE file.** Planned only, not shipping.

## 4. Open questions for counsel

1. ⚠ Does shipping the ORT native libraries and WASM in the MCPB bundle and compiled binaries, without the
   ORT notice in the artifact (G2), satisfy MIT? Is adding the notice to each artifact the expected fix?
2. ⚠ Foundry Local CLI: the restriction on providing the software "as a stand-alone offering or
   combin[ing] it with any of your applications for others to use" (section 1). Does it block any
   planned use, including an optional user-installed runtime that obsidian-tc only calls?
3. ⚠ CUDA EULA: which version governs, and do the Attachment A redistribution conditions (private
   directory, customer flow-down) apply to the current version? The page read showed a version date and
   a footer date that disagree.
4. ⚠ TensorRT-RTX: is the developer tool named as distributable in the current agreement? The PDF was
   not readable; this needs the full text.
5. ⚠ NIM: which terms govern the hosted build.nvidia.com API (not found in this pass), and does a
   self-hosted container's NVIDIA Open Model Agreement flow down to our users?
6. ⚠ Gemma flow-down (G7): if EmbeddingGemma returns, the §3.1 flow-down and the Prohibited Use Policy
   must be written into our terms.
7. ⚠ AGPL interaction with Apache-2.0 and MIT components: this doc assumes they combine into an AGPL work,
   based on the FSF licence list (not re-read here). Counsel to confirm, including for the `openvino`
   Apache-2.0 §4 NOTICE duty.
8. ⚠ Windows ML, MIGraphX and Vitis AI: what licence governs an execution provider delivered by Windows
   Update, and whether we may call it without bundling it.

## 5. Sources and checked dates

All dated 2026-10-19 unless noted.

- AGPL-3.0 (repo): [LICENSE](../LICENSE)
- Foundry Local License Terms: https://raw.githubusercontent.com/microsoft/Foundry-Local/main/LICENSE (partial read)
- `foundry-local-sdk` 2.1.0 LICENSE (MIT): https://www.npmjs.com/package/foundry-local-sdk
- NVIDIA TensorRT RTX License (21Apr2025): https://developer.download.nvidia.com/licenses/NVIDIA_TensorRT_RTX_License_(21Apr2025).pdf (not readable; search snippet only)
- NVIDIA CUDA EULA v13.4: https://docs.nvidia.com/cuda/eula/index.html
- NGC Model-Free NIM: https://catalog.ngc.nvidia.com/orgs/nim/nvidia/containers/model-free-nim/3.0.0 (search snippet only)
- WindowsAppSDK LICENSE (MIT): https://github.com/microsoft/WindowsAppSDK/blob/main/LICENSE
- OpenVINO LICENSE (Apache-2.0): https://github.com/openvinotoolkit/openvino/blob/master/LICENSE
- `openvino-genai-node` 2026.4.1: https://www.npmjs.com/package/openvino-genai-node
- `@huggingface/transformers` 4.3.1 LICENSE (Apache-2.0): https://www.npmjs.com/package/@huggingface/transformers
- `onnxruntime-node` 1.30.0 (MIT): https://www.npmjs.com/package/onnxruntime-node
- `onnxruntime-web` 1.30.0 (MIT): https://www.npmjs.com/package/onnxruntime-web
- `sqlite-vec` 0.1.9: https://www.npmjs.com/package/sqlite-vec; LICENSE-MIT: https://github.com/asg017/sqlite-vec/blob/main/LICENSE-MIT
- `ort` crate: https://crates.io/crates/ort (MIT OR Apache-2.0)
- `all-smi` crate 0.28.0: https://crates.io/crates/all-smi (Apache-2.0)
- nomic-embed-text-v1.5: https://huggingface.co/nomic-ai/nomic-embed-text-v1.5 (apache-2.0)
- all-MiniLM-L6-v2 (Xenova): https://huggingface.co/Xenova/all-MiniLM-L6-v2 (apache-2.0)
- bge-m3: https://huggingface.co/BAAI/bge-m3 (mit)
- bge-reranker-v2-m3: https://huggingface.co/BAAI/bge-reranker-v2-m3 (apache-2.0)
- EmbeddingGemma-300M: https://huggingface.co/google/embeddinggemma-300m (gemma)
- Gemma Terms: https://ai.google.dev/gemma/terms (modified 2026-04-01)
- Qwen3-Embedding-0.6B: https://huggingface.co/Qwen/Qwen3-Embedding-0.6B (apache-2.0)

## 6. Not verified

- Windows ML runtime, MIGraphX and Vitis AI execution-provider licences: not found.
- NIM hosted API (build.nvidia.com) terms: not found.
- cuDNN SLA text: not read.
- TensorRT-RTX full text: PDF not readable; only snippets.
- CUDA Attachment A redistribution conditions: not on the page read.
- Foundry Local CLI full text: only the first sections.
- Xenova mirror pages for `bge-small-en-v1.5` and the reranker `ms-marco-MiniLM-L-6-v2`: not read.
- Platform packages of `sqlite-vec` and `onnxruntime-*`: not inspected for notice files.
- Remote worker container image contents: not inspected.
- Whether the in-product docs or the MCPB manifest disclose model licences: not read end to end.
- FSF GPL-compatibility claims for Apache-2.0 and MIT: stated from the FSF list, not re-fetched.
