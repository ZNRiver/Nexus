# NEXUS

**Self-hosted PaaS control plane** — deploy and manage applications, databases, Docker containers, Docker Compose stacks and game servers across local and remote machines, all through one dashboard backed by a real API and a real agent.

Everything rendered in the UI is backed by working backend logic: deployments run real `git clone` → `docker build` → container runs, databases are provisioned as real containers with persistent volumes, remote servers are added over real SSH, and the agent streams real-time heartbeats, logs and metrics over WebSocket.

```
                    NEXUS DASHBOARD
                           │
                           ▼
                    NEXUS API (Bun)
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
         PostgreSQL                Redis (prod)
              │                         │
              ▼                         ▼
            Jobs / Workers           (queue)
              │
              ▼
       NEXUS AGENT (per server)
              │
         Docker Engine
              │
   ┌──────────┼──────────┐
   ▼          ▼          ▼
 Apps     Databases   Game Servers
```

## Architecture

Every server — the machine NEXUS runs on (Local Server) and any remote machine you add — runs a **NEXUS Agent**. The API never talks to Docker directly; it talks to agents. The dashboard never knows whether a resource lives locally or remotely: it sends `serverId` and the API routes the request to the right agent.

```
                         NEXUS
                           │
              ┌────────────┴────────────┐
              │                         │
         LOCAL SERVER              REMOTE SERVER
              │                         │
        NEXUS AGENT               NEXUS AGENT
              │                         │
           Docker                    Docker
```

### Monorepo layout

```
apps/
  dashboard/   React + Vite + Tailwind + TanStack Query (OpenShip-style design system)
  api/         Bun + Hono REST API, WebSocket hub, job workers, SSH provisioning
  agent/       Bun WebSocket agent: Docker, deployments, backups, metrics, heartbeats
packages/
  types/       Shared domain, API and agent-protocol types (single source of truth)
  database/    Typed data layer — SQLite (dev) / PostgreSQL (prod), real migrations
  config/      Environment configuration
  logger/      Structured JSON logger
docker/
  compose/     Production compose stack (root docker-compose.yml)
migrations/    (SQL migrations live in packages/database/migrations)
```

## Features

- **Setup wizard** — first-run creates the administrator account and the Local Server (hostname, OS, CPU, RAM, disk, Docker detected automatically).
- **Authentication** — email + Argon2id password hashing, session cookies, logout, session listing/revocation, rate limiting, protected routes.
- **Servers** — Local Server + Remote Servers added over real SSH (password or private key), with Test Connection and one-click **Install NEXUS Agent** (provision, install, register, heartbeat).
- **Server status** — CONNECTING / ONLINE / OFFLINE / ERROR / INSTALLING / MAINTENANCE, derived from real heartbeats, never just the database.
- **Applications** — Git repositories deployed via **Dockerfile** or **Docker Compose**, pinned to a server and project.
- **Deployments** — async job pipeline: QUEUED → CLONING → BUILDING → DEPLOYING → STARTING → HEALTH_CHECK → SUCCESS/FAILED, with real-time streamed logs over WebSocket, cancel and rollback.
- **Environment variables & secrets** — stored encrypted, masked by default, revealable only on explicit action.
- **Domains** — attach multiple hostnames per application, SSL flags, prepared reverse-proxy abstraction (`ProxyProvider`).
- **Databases** — PostgreSQL, MySQL, MariaDB, Redis and MongoDB as Docker containers with persistent volumes, connection strings, backup/restore (pg_dump, mysqldump, mariadb-dump, mongodump, RDB).
- **Containers / Images / Volumes / Networks** — full Docker resource management through the agent.
- **Game servers** — Minecraft (Paper, Purpur, Fabric, Forge, Vanilla) in containers with memory/CPU/storage limits.
- **Monitoring** — agent-collected CPU/RAM/disk/network/load + per-container stats, persisted as aggregated series.
- **Notifications, audit log, RBAC permissions, structured error responses, retention/cleanup workers.**

## Requirements

- [Bun](https://bun.sh) ≥ 1.3 (dev & runtime)
- Node.js ≥ 20 (for the dashboard toolchain, optional — Bun can drive it too)
- Docker Engine (anywhere you want the agent to deploy; the NEXUS API/agent itself only needs it for local deployments)
- Linux/macOS recommended for remote servers; the control plane runs anywhere Bun runs

## Quick start (development)

Uses a **local SQLite database** and an in-process queue — zero external services:

```bash
bun install
cp .env.example .env            # defaults are dev-friendly
bun run dev                     # API on :8080 + dashboard on :5173 (Turbo, parallel)
```

Open http://localhost:5173 → you'll be guided through the setup wizard (admin account + Local Server). The local agent connects automatically, and the server shows **ONLINE** with live heartbeats.

> The dev database lives at `apps/api/data/nexus.sqlite` and is created/migrated automatically at boot.

### Production (Docker)

```bash
cp .env.example .env
# set NODE_ENV=production, DATABASE_URL, REDIS_URL, SESSION_SECRET, ENCRYPTION_KEY, PUBLIC_URL
docker compose up -d --build
```

`nexus-api` serves the dashboard and API on `:8080`, `nexus-postgres` and `nexus-redis` run alongside. The compose file mounts `/var/run/docker.sock` so the local agent can manage containers on the host.

Migrations run automatically at API startup.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development` → SQLite + in-process queue; `production` → PostgreSQL + Redis |
| `PORT` | `8080` | API / dashboard (prod) port |
| `API_URL` | `http://localhost:8080` | Base URL of the API (used by the agent to connect) |
| `PUBLIC_URL` | `http://localhost:5173` | Public origin — used for CORS (set to the real origin in production) |
| `COOKIE_SECURE` | `false` | Set `true` behind HTTPS |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy (X-Forwarded-For) |
| `DATABASE_URL` | `sqlite:data/nexus.sqlite` | `sqlite:path` (dev) or `postgres://…` (prod) |
| `REDIS_URL` | `redis://localhost:6379` | Optional in dev; used for the production queue |
| `SESSION_SECRET` | — | 32+ random hex bytes; signs session cookies |
| `ENCRYPTION_KEY` | — | 32 random hex bytes; encrypts secrets at rest |
| `AGENT_API_URL` | `http://localhost:8080` | Where the local agent connects back to |
| `DOCKER_HOST` | platform socket | Unix socket, `npipe://…` on Windows, or TCP |
| `DASHBOARD_PORT` | `5173` | Vite dev server port |

Generate secrets with: `openssl rand -hex 32`

## The NEXUS Agent

Every server (local or remote) runs the same agent (`apps/agent`). It:

- connects **outbound** to the API over authenticated WebSocket (`/ws/agent?serverId=&token=`),
- sends **heartbeats** with CPU / memory / disk every few seconds,
- streams **metrics** and **container stats**,
- executes validated, typed commands: deployments (Dockerfile + Compose), database create/backup/restore, game-server create/start/stop, container ops, image pull, volume/network ops,
- streams **deployment logs** back in real time.

The agent never exposes Docker directly to the internet and validates every command it receives (auth, type, ownership, payload, timeouts).

### Adding a remote server

1. **Servers → Add Server** (name, host, port, username, auth method).
2. **Test Connection** — the API really connects over SSH and reports OS, architecture and Docker version.
3. **Install NEXUS Agent** — the API uploads and starts the agent on the remote host, registers it, and the server goes **ONLINE** once heartbeats arrive.

## API overview

All routes are under `/api/v1` and protected by session auth + permission checks:

```
auth        POST /setup, /auth/register, /auth/login, /auth/logout, /auth/me
servers     GET/POST /servers, /servers/:id, /servers/:id/test, /install-agent, /reconnect, /metrics, /containers
projects    GET/POST /projects, DELETE /projects/:id
applications GET/POST /applications, /applications/:id (PATCH/DELETE), /deploy, /rollback, /restart, /stop
            /applications/:id/environment, /domains, /deployments, /logs
deployments GET /deployments, /deployments/:id, /deployments/:id/logs, POST /deployments/:id/cancel
databases   GET/POST /databases, /databases/:id (GET/DELETE), /backup, /backups, /connection/reveal
backups     POST /backups/:id/restore, DELETE /backups/:id
infra       GET/POST /containers, /containers/:id/:action, /logs, /exec, /inspect
            GET/POST /images (+/pull, DELETE), /volumes, /networks
games       GET/POST /game-servers, /game-servers/:id (GET/DELETE), /start, /stop
monitoring  GET /monitoring/servers/:serverId
misc        GET /overview, /notifications, /audit, /jobs, /settings (PATCH), /search, /health
```

Errors are always structured: `{ "error": { "code": "SERVER_OFFLINE", "message": "…" } }` — no stack traces leak to clients.

## Security model

- Argon2id password hashing; never plaintext.
- Secrets (env values, SSH keys, registry passwords, agent tokens, DB passwords) encrypted at rest with `ENCRYPTION_KEY`; masked in responses, reveal-only on explicit actions.
- Session cookies `HttpOnly`, `SameSite=Lax`, optional `Secure`; sessions revocable individually or globally.
- Rate limiting on auth endpoints and per-IP guards.
- Permission checks (owner/admin/developer/viewer) on every route via a central permission table.
- Full audit log for administrative actions.
- Structured logging (timestamp, level, service, requestId, userId, serverId, resource).

## Troubleshooting

- **Port 8080 in use** — change `PORT` in `.env`, or kill the existing process.
- **Local server stays OFFLINE** — the agent spawns after setup; check `apps/api` logs. On Windows without Docker, heartbeats still flow; Docker-backed actions return structured errors.
- **`EADDRINUSE` on boot** — another NEXUS/API instance is running (or the previous one wasn't shut down).
- **Deploy fails with `git clone failed`** — repository URL is wrong or private (private repos need credentials baked into the URL or a future registry/credential store).
- **Deploy fails with `docker` not found** — the agent host needs Docker Engine; `docker ps` must work for the agent's user.
- **SQLite busy errors** — remove `apps/api/data/nexus.sqlite*` while the API is stopped and restart.
- **Migrate manually** — `bun run db:migrate`.

## UI conventions

See [`docs/ui-patterns.md`](docs/ui-patterns.md) for the dashboard's design conventions — modal sizing (stable, never content-driven), pinned modal footers, the `CustomSelect` component (native `<select>` is not used), hover states and brand database logos.

## Roadmap

The codebase is phased so features can be built on the full vertical stack (UI → API → queue → agent → Docker → real-time → UI). Notable next steps: reverse-proxy routing for domains (nginx/traefik provider), S3 backup destinations, private Git credentials, SSO/RBAC UI, agent auto-updates, E2E tests.
