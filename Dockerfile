# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────
# NEXUS — self-hosted PaaS control plane
#
# The API serves the built dashboard (SPA) on the same port and
# spawns the Local NEXUS Agent in-process, so a single container
# is the whole control plane. Mount the Docker socket to let the
# local agent manage containers on the host.
# ─────────────────────────────────────────────────────────────

FROM oven/bun:1.3-debian AS base
WORKDIR /app

# ── Install dependencies (full workspace) ─────────────────────
FROM base AS deps
COPY package.json bun.lock ./
# Copy all workspace manifests so `bun install --frozen-lockfile` resolves them.
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/agent/package.json apps/agent/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/logger/package.json packages/logger/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/database/package.json packages/database/package.json
RUN bun install --frozen-lockfile

# ── Build the dashboard (static SPA) ──────────────────────────
FROM deps AS builder
COPY . .
RUN bun run --cwd apps/dashboard build

# ── Runtime ───────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/api ./apps/api
COPY --from=builder /app/apps/agent ./apps/agent
COPY --from=builder /app/apps/dashboard/dist ./apps/dashboard/dist
COPY --from=builder /app/package.json ./package.json

# Runtime data (SQLite dev / agent workdir / backups live here).
RUN mkdir -p /data/nexus /opt/nexus/agent/work /opt/nexus/agent/backups

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e 'fetch("http://127.0.0.1:8080/api/health").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'

ENTRYPOINT ["bun", "apps/api/src/index.ts"]
