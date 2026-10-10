# Web app image: builds the Vite bundle, then serves it with Caddy (see Caddyfile).
# The hosted app at app.ohiyo.gg runs this on Railway; `railway.json` selects it.
#
# The backend address is baked in at build time from `.env.production`
# (VITE_SERVER_URL). To point the app at your own server, change that file and rebuild.

FROM node:22-bookworm-slim AS build
# Bun installs the packages; Node still runs tsc and Vite. Keep this version in step with
# `bun-version` in the GitHub workflows.
COPY --from=oven/bun:1.4.3 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
# public/_headers is for Cloudflare Pages; Caddy sets the same headers itself.
RUN bun run build && rm -f dist/_headers

FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
