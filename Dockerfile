# obsidian-tc server image (G2.5 §2.4). Single-stage oven/bun:1-slim (Debian trixie-slim, glibc)
# build: install deps, build shared + server, run the CLI as the image's non-root `bun` user.
# glibc base (NOT alpine/musl): the native prebuilds are gnu-only, so a gnu .node can never load
# against musl — alpine forces the silent pure-JS fallback. This swap removes that musl blocker;
# native still runs pure-JS in the image until a release publishes the platform sub-packages AND
# the image installs the umbrella from npm (today it builds from the workspace, which pins no
# native optionalDependencies and never builds packages/native). Larger glibc fallback if a slim
# lib is missing: oven/bun:1-debian. Built + pushed to ghcr.io by .github/workflows/publish.yml on
# a human-pushed v* tag — NOT built in CI here (config-verified only). A multi-stage slim image +
# bundled native prebuilds remain a follow-up.
FROM oven/bun:1-slim
WORKDIR /app
COPY . .
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && bun install --frozen-lockfile --ignore-scripts \
 && (cd packages/shared && bun run build) \
 && (cd packages/server && bun run build) \
 && chown -R bun:bun /app
# Run unprivileged. The `bun` user (uid 1000) owns /app after the chown above, so the default
# cache dir (<cwd>/.obsidian-tc) stays writable; mount any external cache/vault dir writable by
# uid 1000.
USER bun
# The CLI takes a vault folder (zero-config) or a config path (OBSIDIAN_TC_CONFIG / argv); the
# serve / config / plugin-install subcommands are available. Pass a vault or config when running.
ENTRYPOINT ["bun", "/app/packages/server/dist/cli.js"]
