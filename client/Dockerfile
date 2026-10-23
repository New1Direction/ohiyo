# Web app image: builds the Vite bundle, then serves it with Caddy (see Caddyfile).
# The hosted app at app.ohiyo.gg runs this on Railway; `railway.json` selects it.
# Build from the repository root: docker build -f client/Dockerfile .
#
# The backend address is baked in at build time from `.env.production`
# (VITE_SERVER_URL). To point the app at your own server, change that file and rebuild.

FROM node:22-bookworm-slim AS build
# Bun installs the packages; Node still runs tsc and Vite. Keep this version in step with
# `bun-version` in the GitHub workflows.
COPY --from=oven/bun:1.4.3 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app/client
COPY client/package.json client/bun.lock ./
RUN bun install --frozen-lockfile
COPY client/ ./
COPY brand/kikka-chinchilla-clean.png /app/brand/kikka-chinchilla-clean.png
# public/_headers is for Cloudflare Pages; Caddy sets the same headers itself.
RUN bun run build && rm -f dist/_headers

FROM caddy:2-alpine
COPY client/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/client/dist /srv
