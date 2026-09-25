# obsidian-tc server image (G2.5 §2.4, THE-276). Multi-stage on glibc oven/bun:1.4.2-slim
# (Debian trixie-slim), pinned to the same Bun version as mise.toml (THE-1118) — a floating
# `1-slim` tag would silently drift the image's Bun off the pin everything else agrees on;
# check-bun-version-coherence.mjs enforces both `FROM oven/bun:` lines below stay in sync.
# glibc base (NOT alpine/musl): the native prebuilds are gnu-only, so a
# gnu .node can never load against musl. The builder installs deps + builds shared + server; the
# runtime stage copies ONLY packages/server/dist. The bundle is built --target node with all npm
# deps (incl. @the-40-thieves/obsidian-tc-shared) inlined and only better-sqlite3 kept external.
# At runtime the entrypoint runs under Bun, so openDatabase() uses the built-in bun:sqlite; the
# external better-sqlite3 and the node:sqlite fallback are never reached, and the native module +
# sqlite-vec are createRequire()-optional (graceful pure-JS fallback when absent). So the runtime
# needs no node_modules: bun runtime + dist (bundle + copy-assets output: migrations/, schema.sql,
# plugin/) is sufficient to boot. ca-certificates stays in the runtime stage for outbound TLS
# (embedding providers / gateway / OTEL exporter). Built + pushed to ghcr.io by publish.yml on a
# human v* tag; the PR gate (ci-docker.yml) does a build + `version` smoke.

# ---- builder: install deps, build shared then server (this whole stage is discarded) ----
FROM oven/bun:1.4.2-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts \
 && (cd packages/shared && bun run build) \
 && (cd packages/server && bun run build) \
 && (cd packages/embedder-local && bun install --frozen-lockfile && bun run build)

# ---- runtime: bun + ca-certs + the server dist only ----
FROM oven/bun:1.4.2-slim
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && chown bun:bun /app
# Copy the built server bundle + its runtime assets (dist/migrations, dist/schema.sql,
# dist/plugin from scripts/copy-assets.mjs). No source, no node_modules — except for
# packages/embedder-local below, which needs its own dist AND node_modules (@huggingface/
# transformers) present.
#
# THE-1122 review round 3: @the-40-thieves/obsidian-tc-embedder-local (the DEFAULT embeddings
# provider — no config block resolves to it) is reachable from this image via the SAME
# source-checkout resolution route local-embedder-registry.ts already walks for a bare monorepo
# checkout (resolveSourceCheckoutLocalEmbedderPath: walk up from the running process, looking for
# packages/embedder-local/package.json as an anchor) — not an `npm add` from the registry, which
# would 404 every PR build until the package's own one-time first publish lands. Copying the whole
# built package (its package.json anchor, dist/, and node_modules/) into the SAME relative path
# under /app is what makes that walk succeed here. This is heavier than the server dist alone
# (@huggingface/transformers's two bundled ONNX runtimes — see embeddings.md's Known Gaps for the
# ~585 MB figure), which is the real, disclosed cost of shipping the default embeddings provider
# working out of the box in this image, not an oversight.
#
# @the-40-thieves/obsidian-tc-reranker-local (the "local" RERANKER — opt-in, not a default) is NOT
# copied here: a missing reranker degrades gracefully to RRF-only, so paying this same image-size
# cost for an opt-in feature nobody may have configured is not justified the way it is for the
# provider `search_semantic` cannot work at all without.
COPY --from=build --chown=bun:bun /app/packages/server/dist /app/packages/server/dist
COPY --from=build --chown=bun:bun /app/packages/embedder-local /app/packages/embedder-local
# Run unprivileged. The `bun` user (uid 1000) owns /app, so the default cache dir
# (<cwd>/.obsidian-tc) stays writable; mount any external cache/vault dir writable by uid 1000.
USER bun
# The CLI takes a vault folder (zero-config) or a config path (OBSIDIAN_TC_CONFIG / argv); the
# serve / config / plugin-install subcommands are available. Pass a vault or config when running.
ENTRYPOINT ["bun", "/app/packages/server/dist/cli.js"]
