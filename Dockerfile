# syntax=docker/dockerfile:1

# Node 26 Debian slim is required for Temporal API (Prisma 8) and native glibc modules (sharp).
FROM node:26-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /app
RUN npm install -g pnpm@12.4.1

FROM base AS deps
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS builder
COPY tsconfig.json tsconfig.build.json nest-cli.json prisma.config.ts ./
COPY types ./types
COPY src ./src
RUN pnpm run build

FROM deps AS migrations
COPY tsconfig.json prisma.config.ts ./
COPY migrations ./migrations
COPY src/prisma ./src/prisma
USER node
CMD ["pnpm", "prisma", "db", "verify"]

FROM base AS prod-deps
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM node:26-bookworm-slim AS production
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

COPY --chown=node:node package.json .npmrc ./
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/v1/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "dist/main.js"]
