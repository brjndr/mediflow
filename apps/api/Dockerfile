# syntax=docker/dockerfile:1
# Build context is the repository root:
#   docker build -f apps/api/Dockerfile -t mediflow-api .
#
# Two stages: the first has pnpm, dev dependencies and the TypeScript sources; the second has only
# Node, production dependencies and compiled JavaScript. node:22-slim is multi-arch, so the same
# file builds for ARM where the platform offers it.

FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable

# Manifests first, so the dependency layer is reused until one of them changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/only-pnpm.mjs scripts/prepare.mjs ./scripts/
COPY apps/api/package.json ./apps/api/
RUN pnpm install --frozen-lockfile --filter api...

COPY tsconfig.base.json ./
COPY apps/api ./apps/api
RUN pnpm --filter api build
# A self-contained folder with the package and its production dependencies only.
RUN pnpm --filter api deploy --prod --legacy /out


FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist

# Never run as root.
USER node
EXPOSE 3000
# Liveness only: it must not fail because the database is briefly unreachable.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# Migrations are a separate, explicit step, run before a new version takes traffic:
#   docker run --rm -e DATABASE_URL=... mediflow-api node dist/core/db/migrate-cli.js
CMD ["node", "dist/server.js"]
