import { createLogger } from "@nexus/logger";
import { getAgentConfig } from "./config";
import { AgentClient } from "./ws/client";

const log = createLogger("agent");

const config = getAgentConfig();
log.info("NEXUS Agent starting", {
  serverId: config.serverId,
  version: config.version,
  apiUrl: config.apiUrl,
  dockerHost: config.dockerHost ?? "default",
});

// Probe Docker availability once at startup so the API immediately sees the truth.
const { DockerService } = await import("./docker/service");
const docker = new DockerService(config.dockerHost);
const available = await docker.available();
log.info("docker availability", { available });

const client = new AgentClient(config);
client.connect();

const shutdown = () => {
  log.info("shutting down");
  client.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
