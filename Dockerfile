# obsidian-tc server image (G2.5 §2.4). Single-stage oven/bun:1-alpine build: install deps,
# build shared + server, run the CLI as the image's non-root `bun` user. Built + pushed to
# ghcr.io by .github/workflows/publish.yml on a human-pushed v* tag — NOT built in CI here
# (config-verified only). A multi-stage slim image + bundled native prebuilds remain a follow-up.
FROM oven/bun:1-alpine
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts \
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
