# obsidian-tc server image (G2.5 §2.4, THE-276). Multi-stage on glibc oven/bun:1-slim
# (Debian trixie-slim). glibc base (NOT alpine/musl): the native prebuilds are gnu-only, so a
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
FROM oven/bun:1-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts \
 && (cd packages/shared && bun run build) \
 && (cd packages/server && bun run build)

# ---- runtime: bun + ca-certs + the server dist only ----
FROM oven/bun:1-slim
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && chown bun:bun /app
# Copy ONLY the built server bundle + its runtime assets (dist/migrations, dist/schema.sql,
# dist/plugin from scripts/copy-assets.mjs). No source, no node_modules.
COPY --from=build --chown=bun:bun /app/packages/server/dist /app/packages/server/dist
# Run unprivileged. The `bun` user (uid 1000) owns /app, so the default cache dir
# (<cwd>/.obsidian-tc) stays writable; mount any external cache/vault dir writable by uid 1000.
USER bun
# The CLI takes a vault folder (zero-config) or a config path (OBSIDIAN_TC_CONFIG / argv); the
# serve / config / plugin-install subcommands are available. Pass a vault or config when running.
ENTRYPOINT ["bun", "/app/packages/server/dist/cli.js"]
