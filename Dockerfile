# obsidian-tc server image (G2.5 §2.4, THE-276). Multi-stage on glibc oven/bun:1.4.2-slim
# (Debian trixie-slim), pinned to the same Bun version as mise.toml (THE-1118) — a floating
# `1-slim` tag would silently drift the image's Bun off the pin everything else agrees on;
# check-bun-version-coherence.mjs enforces both `FROM oven/bun:` lines below stay in sync.
# glibc base (NOT alpine/musl): the native prebuilds are gnu-only, so a
# gnu .node can never load against musl. The builder installs deps + builds shared + server; the
# runtime stage copies ONLY packages/server/dist. The bundle is built --target node with all npm
# deps (incl. @the-40-thieves/obsidian-tc-shared) inlined and only better-sqlite3 kept external.
# At runtime the entrypoint runs under Bun, so openDatabase() uses the built-in bun:sqlite; the
# external better-sqlite3 and the node:sqlite fallback are never reached. The runtime stage does
# ship a small node_modules next to dist/ (see "Runtime-only node_modules" below): the bundle
# resolves sqlite-vec and @the-40-thieves/obsidian-tc-native through createRequire() at run time, and
# @redis/client through a lazy import, none of which `bun build` can inline. Both createRequire
# lookups degrade silently (brute-force cosine scan / pure-JS fallback) when the package is absent,
# so a missing copy never fails the boot: it only shows up as `vec=off` / `native=js-fallback` in
# the ready banner. ci-docker boots the image with no network and asserts `vec=on native=on` so that
# degradation fails the PR instead. Do NOT rely on Bun's runtime auto-install to fill the gap: it
# is disabled the moment ANY node_modules directory is found above the importing file (that is
# how 1.32.0, which gained a node_modules for @redis/client, lost vec=on), and it needs the network.
# ca-certificates stays in the runtime stage for outbound TLS (embedding providers / gateway / OTEL
# exporter). Built + pushed to ghcr.io by publish.yml on a human v* tag; the PR gate (ci-docker.yml)
# does a build + `version` smoke + the offline boot smoke.

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

# Runtime-only node_modules, staged into /out/node_modules for the runtime stage. Everything the
# bundle resolves at run time from dist/ rather than inlining:
#   - @redis/client (+ cluster-key-slot, @opentelemetry/api): the optional rate-limit backend,
#     throttle.backend "redis".
#   - sqlite-vec (+ the platform package sqlite-vec-linux-<arch> bun picked for THIS build
#     platform): the vec0 extension loaded by search/vec.ts through createRequire().
# Bun's isolated install keeps each package and its dependency symlinks under one
# .bun/<name>@<ver>*/node_modules directory; `cp -rL` flattens that into a plain node_modules
# holding EXACTLY the lockfile-pinned versions and their lockfile-pinned dependencies, and nothing
# else from the tree. The globs match whatever bun.lock pins (the sqlite-vec glob cannot match the
# sqlite-vec-linux-* platform directories: the `@` must follow the bare name); if a package ever
# stops being installed the glob matches nothing and `cp` fails the build. The multi-arch build runs
# this stage once per platform (linux/amd64, linux/arm64), so each image gets its own platform
# package without any arch logic here; the last command resolves the extension the way
# search/vec.ts does.
RUN mkdir -p /out/node_modules \
 && cp -rL /app/node_modules/.bun/@redis+client@*/node_modules/. /out/node_modules/ \
 && cp -rL /app/node_modules/.bun/sqlite-vec@*/node_modules/. /out/node_modules/ \
 && test -f /out/node_modules/@redis/client/package.json \
 && (cd /out && bun --eval 'const p = require("sqlite-vec").getLoadablePath(); if (!p.endsWith("/vec0.so")) throw new Error(p); console.log("sqlite-vec loadable:", p)')

# @the-40-thieves/obsidian-tc-native: the compiled napi module (cosine/BM25 + the symlink-safe vault
# I/O). It is a workspace package, so `bun install` links it but nothing here compiles it (no Rust
# toolchain in this image); the prebuilt glibc .node for this image's arch has to be in the build
# context as packages/native/obsidian-tc-native.linux-<x64|arm64>-gnu.node, which is exactly where
# packages/native/index.js looks first. ci-docker builds it from source on the runner, publish.yml
# downloads the release matrix's build, release-image.yml unpacks it from the published npm
# platform package. Without it the server silently runs the pure-JS fallback (`native=js-fallback`
# in the ready banner), so the build fails when it is missing unless NATIVE_REQUIRED=0 is passed
# (local builds with no Rust toolchain).
ARG TARGETARCH
ARG NATIVE_REQUIRED=1
RUN set -eu; \
    case "$TARGETARCH" in amd64) napi_arch=x64 ;; arm64) napi_arch=arm64 ;; *) napi_arch="unsupported-$TARGETARCH" ;; esac; \
    node_file="packages/native/obsidian-tc-native.linux-${napi_arch}-gnu.node"; \
    dest=/out/node_modules/@the-40-thieves/obsidian-tc-native; \
    mkdir -p "$dest"; \
    cp packages/native/package.json packages/native/index.js packages/native/fallback.js "$dest/"; \
    if [ -f "$node_file" ]; then \
      cp "$node_file" "$dest/"; \
    elif [ "$NATIVE_REQUIRED" = "1" ]; then \
      echo "missing $node_file: build the native module for linux-${napi_arch}-gnu first (see packages/native), or pass --build-arg NATIVE_REQUIRED=0 to accept the pure-JS fallback" >&2; \
      exit 1; \
    else \
      echo "WARNING: no $node_file; this image will run the pure-JS fallback" >&2; \
    fi

# ---- runtime: bun + ca-certs + the server dist only ----
FROM oven/bun:1.4.2-slim AS runtime
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data/vault /data/cache \
 && chown -R bun:bun /app /data
# Copy the built server bundle + its runtime assets (dist/migrations, dist/schema.sql,
# dist/plugin from scripts/copy-assets.mjs). No source; node_modules only as staged above
# (packages/server/node_modules) plus packages/embedder-local below, which needs its own dist AND
# node_modules (@huggingface/transformers) present.
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
# Runtime-only node_modules (sqlite-vec, @the-40-thieves/obsidian-tc-native, @redis/client and its
# dependencies), copied to packages/server/node_modules so the bare specifiers resolve from dist/ by
# the ordinary walk up. A few tens of MB; the rest of the tree stays out.
COPY --from=build --chown=bun:bun /out/node_modules /app/packages/server/node_modules
# The HTTP server defaults to 8765. /data is the stable vault/cache mount; a child image cannot
# undeclare an inherited VOLUME, so downstream images should treat this path as part of the image API.
EXPOSE 8765
VOLUME ["/data"]
# Run unprivileged. The `bun` user (uid 1000) owns /app, so the default cache dir
# (<cwd>/.obsidian-tc) stays writable; mount any external cache/vault dir writable by uid 1000.
# The pinned oven/bun base defines this fixed uid; keep its readable account name in image metadata.
# hadolint ignore=DL3066
USER bun
# A refused listener is healthy only for stdio sessions (PORT unset). Once PORT declares HTTP,
# anything except /healthz 200 is unhealthy; timeouts and non-200 responses always fail.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 CMD ["bun", "-e", "function classifyHealthcheckError(error){const code=error?.cause?.code??error?.code;return code===\"ConnectionRefused\"||code===\"ECONNREFUSED\"?\"refused\":error?.name===\"AbortError\"?\"timeout\":\"error\";}const portSet=Boolean(process.env.PORT);const port=process.env.PORT||\"8765\";const c=new AbortController();const t=setTimeout(()=>c.abort(),8000);let outcome=\"timeout\";try{const r=await fetch(\"http://127.0.0.1:\"+port+\"/healthz\",{signal:c.signal});outcome=r.status===200?\"ok\":\"http-\"+r.status}catch(e){outcome=classifyHealthcheckError(e)}finally{clearTimeout(t)}process.exit(outcome===\"ok\"||(!portSet&&outcome===\"refused\")?0:1)"]
# The CLI takes a vault folder (zero-config) or a config path (OBSIDIAN_TC_CONFIG / argv); the
# serve / config / plugin-install subcommands are available. Pass a vault or config when running.
ENTRYPOINT ["bun", "/app/packages/server/dist/cli.js"]

# ---- git: the -git variant, which syncs the vault from a Git remote (git-sync --supervise) ----
# git and openssh-client add ~112 MB (git pulls in perl), so they live in this stage alone: the
# default image stays free of them, and a Git-backed deployment opts in with the :<version>-git tag.
# The launcher clones or verifies the vault, starts the server as a child, and exits when either
# process exits. Everything else (EXPOSE, VOLUME, HEALTHCHECK) is inherited from the runtime stage.
FROM runtime AS git
# hadolint ignore=DL3066
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client \
 && rm -rf /var/lib/apt/lists/*
# hadolint ignore=DL3066
USER bun
ENTRYPOINT ["bun", "/app/packages/server/dist/cli.js", "git-sync", "--supervise"]

# The default build target: the last stage is the runtime image itself, so an untargeted
# `docker build` (and every existing build site) still produces the default image with no -git tools.
FROM runtime
