export interface AgentConfig {
  apiUrl: string;
  token: string;
  serverId: string;
  version: string;
  dockerHost: string | null;
  heartbeatIntervalMs: number;
  metricsIntervalMs: number;
  /** per-action timeout for one-shot docker commands */
  commandTimeoutMs: number;
  /** how often to check the API for a newer agent bundle (0 disables) */
  updateIntervalMs: number;
  /** directory where agent data lives (bundle sits one level up) */
  dataDir: string;
}

export function getAgentConfig(env: Record<string, string | undefined> = process.env): AgentConfig {
  const token = env.AGENT_TOKEN;
  const serverId = env.AGENT_SERVER_ID;
  if (!token) throw new Error("AGENT_TOKEN is required");
  if (!serverId) throw new Error("AGENT_SERVER_ID is required");

  const apiUrl = env.AGENT_API_URL ?? "http://localhost:8080";

  return {
    apiUrl,
    token,
    serverId,
    version: env.AGENT_VERSION ?? "0.1.0",
    dockerHost: env.DOCKER_HOST ?? null,
    heartbeatIntervalMs: parseInt(env.AGENT_HEARTBEAT_INTERVAL_MS ?? "10000", 10),
    metricsIntervalMs: parseInt(env.AGENT_METRICS_INTERVAL_MS ?? "10000", 10),
    commandTimeoutMs: parseInt(env.AGENT_COMMAND_TIMEOUT_MS ?? "120000", 10),
    updateIntervalMs: parseInt(env.AGENT_UPDATE_INTERVAL_MS ?? "60000", 10),
    dataDir: env.AGENT_DATA_DIR ?? "/opt/nexus/agent/data",
  };
}
