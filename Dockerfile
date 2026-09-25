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
 && (cd packages/server && bun run build)

# ---- runtime: bun + ca-certs + the server dist only ----
FROM oven/bun:1.4.2-slim
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && chown bun:bun /app
# Copy ONLY the built server bundle + its runtime assets (dist/migrations, dist/schema.sql,
# dist/plugin from scripts/copy-assets.mjs). No source, no node_modules.
#
# THE-1122: this means the optional @the-40-thieves/obsidian-tc-embedder-local package (the
# DEFAULT embeddings provider — no config block resolves to it) is UNREACHABLE from this image
# today, the same way @the-40-thieves/obsidian-tc-reranker-local always has been here (its "local"
# is opt-in, so that gap was low-stakes; embedder-local's is not, since it's the default). Neither
# package is published to npm yet (see each package's own README's "Publishing status"), so there
# is no `bun add` this stage could run that would resolve either one — wiring that in NOW would
# make every PR's ci-docker.yml build fail on a 404 until the owner's one-time first publish
# lands. Once published, adding an explicit `bun add @the-40-thieves/obsidian-tc-embedder-local`
# install step to the builder stage (mirroring reranker-local's own future wiring) plus copying
# its resolved node_modules subset into the runtime stage is the follow-up — tracked, not silently
# dropped. Until then, `embeddings.buildable` in `obsidian-tc doctor` reports this correctly (FAIL,
# not a source-checkout WARN, since this image has no packages/embedder-local directory to find
# either), and install.md/embeddings.md name the workaround (a hosted/self-hosted provider).
COPY --from=build --chown=bun:bun /app/packages/server/dist /app/packages/server/dist
# Run unprivileged. The `bun` user (uid 1000) owns /app, so the default cache dir
# (<cwd>/.obsidian-tc) stays writable; mount any external cache/vault dir writable by uid 1000.
USER bun
# The CLI takes a vault folder (zero-config) or a config path (OBSIDIAN_TC_CONFIG / argv); the
# serve / config / plugin-install subcommands are available. Pass a vault or config when running.
ENTRYPOINT ["bun", "/app/packages/server/dist/cli.js"]
