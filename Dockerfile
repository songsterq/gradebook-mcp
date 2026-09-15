# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
WORKDIR /app
# Pinned to match "packageManager" in package.json. Not corepack: the corepack
# bundled with node 22 predates pnpm 12's package layout and cannot launch it.
RUN npm install -g pnpm@12.3.4

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# A container must bind 0.0.0.0 for Docker to publish the port. That is safe
# here because Compose publishes the dashboard to UI_BIND_ADDR (loopback by
# default) on the host, so the wildcard bind is confined outside the process.
ENV UI_ALLOW_WILDCARD_BIND=true
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

RUN mkdir -p /data && chown node:node /data

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.PORT||process.env.UI_PORT;if(!p){process.exit(1)}fetch('http://127.0.0.1:'+p+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Both listeners are optional, each disabled by a blank port. 3000: MCP endpoint
# (authenticated). 3001: dashboard (unauthenticated, private networks only).
# Both serve /healthz, so the probe above works in any mode.
EXPOSE 3000 3001
# Suppress node:sqlite's Node 22 warning for the app only, so logs stay JSON
# without changing the separate node process used by HEALTHCHECK.
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
