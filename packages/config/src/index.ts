/**
 * NEXUS — central configuration.
 * Loads .env (if present), validates required values and exposes typed config.
 *
 * NODE_ENV=development → local SQLite database + in-process queue.
 * NODE_ENV=production   → PostgreSQL + Redis.
 */

import { existsSync, readFileSync } from "node:fs";
import { createLogger } from "@nexus/logger";

const log = createLogger("config");

export interface NexusConfig {
  env: "development" | "production" | "test";
  port: number;
  apiUrl: string;
  publicUrl: string;
  cookieSecure: boolean;
  trustProxy: boolean;

  databaseUrl: string;
  isSqlite: boolean;

  redisUrl: string | null;

  sessionSecret: string;
  encryptionKey: string;

  agentApiUrl: string;
  dockerHost?: string | null;

  localAgent: {
    enabled: boolean;
    /** binary path of the bundled agent to spawn for the Local Server */
    path?: string | null;
  };

  dashboardPort: number;
}

function loadEnv(): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {};
  // .env wins over the ambient process.env so a checked-in dev .env is the
  // single source of truth for local runs (e.g. PORT=0 artifacts in CI shells).
  try {
    const envPath = process.cwd() + "/.env";
    if (existsSync(envPath)) {
      const text = readFileSync(envPath, "utf8");
      for (const rawLine of text.split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        values[key] = value;
      }
    }
  } catch {
    /* .env optional */
  }
  // Ambient vars fill gaps only.
  for (const [key, value] of Object.entries(process.env)) {
    if (!(key in values)) values[key] = value;
  }
  return values;
}

export function getConfig(overrides: Record<string, string> = {}): NexusConfig {
  const env: Record<string, string | undefined> = { ...loadEnv(), ...overrides };
  const nodeEnv = (env.NODE_ENV ?? "development") as NexusConfig["env"];
  const isProd = nodeEnv === "production";

  const databaseUrl = env.DATABASE_URL ?? (isProd ? "postgres://nexus:nexus@localhost:5432/nexus" : "sqlite:data/nexus.sqlite");
  const isSqlite = databaseUrl.startsWith("sqlite:");

  if (isProd) {
    if (!env.SESSION_SECRET || env.SESSION_SECRET.startsWith("change-me")) {
      throw new Error("SESSION_SECRET must be set to a random value in production");
    }
    if (!env.ENCRYPTION_KEY || env.ENCRYPTION_KEY.startsWith("change-me")) {
      throw new Error("ENCRYPTION_KEY must be set to a random value in production");
    }
  }

  const config: NexusConfig = {
    env: nodeEnv,
    port: parseInt(env.PORT ?? "8080", 10) || 8080,
    apiUrl: env.API_URL ?? "http://localhost:8080",
    publicUrl: env.PUBLIC_URL ?? "http://localhost:5173",
    cookieSecure: env.COOKIE_SECURE === "true" || (isProd && env.COOKIE_SECURE !== "false"),
    trustProxy: env.TRUST_PROXY === "true",

    databaseUrl,
    isSqlite,

    redisUrl: env.REDIS_URL ?? (isProd ? "redis://localhost:6379" : null),

    sessionSecret: env.SESSION_SECRET ?? "dev-session-secret-not-for-production",
    encryptionKey: env.ENCRYPTION_KEY ?? "dev-encryption-key-not-for-production",

    agentApiUrl: env.AGENT_API_URL ?? "http://localhost:8080",
    dockerHost: env.DOCKER_HOST ?? null,

    localAgent: {
      enabled: env.LOCAL_AGENT_ENABLED !== "false",
      path: env.LOCAL_AGENT_PATH ?? null,
    },

    dashboardPort: parseInt(env.DASHBOARD_PORT ?? "5173", 10) || 5173,
  };

  if (isProd && isSqlite) {
    throw new Error("Production cannot use the SQLite database. Set DATABASE_URL to PostgreSQL.");
  }

  log.info("configuration loaded", { env: nodeEnv, database: isSqlite ? "sqlite" : "postgres", redis: config.redisUrl ? "yes" : "no" });
  return config;
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}
