# obsidian-tc server image (G2.5 §2.4). Single-stage oven/bun:1-alpine build: install deps,
# build shared + server, run the CLI. Built + pushed to ghcr.io by .github/workflows/publish.yml
# on a human-pushed v* tag — NOT built in CI here (config-verified only). A multi-stage slim
# image + bundled native prebuilds are a v1.1 follow-up.
FROM oven/bun:1-alpine
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts \
 && bun run --filter=shared build \
 && bun run --filter=server build
# The v1.0 CLI launches from a config path (OBSIDIAN_TC_CONFIG env or argv[2]). The richer
# `obsidian-tc serve/init/auth/...` subcommand surface (G2.5 §5) is a documented follow-up, so
# there is no `serve` CMD yet — pass a config path or set OBSIDIAN_TC_CONFIG when running.
ENTRYPOINT ["bun", "/app/packages/server/dist/cli.js"]
