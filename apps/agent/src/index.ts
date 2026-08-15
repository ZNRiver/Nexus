import { createLogger } from "@nexus/logger";
import { getAgentConfig } from "./config";
import { AgentClient } from "./ws/client";

const log = createLogger("agent");

const config = getAgentConfig();
log.info("agent build", { build: "e2e-self-update-v2" });
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

// Self-update: periodically compare the running bundle against the API and
// swap + restart when a newer build is published.
const { SelfUpdater } = await import("./self-update");
const updater = new SelfUpdater(config, config.dataDir);

const client = new AgentClient(config, updater);
client.connect();
if (config.updateIntervalMs > 0) {
  const run = () => {
    void updater.checkAndUpdate().catch(() => {});
  };
  run();
  setInterval(run, config.updateIntervalMs);
  log.info("self-update enabled", { intervalMs: config.updateIntervalMs });
} else {
  log.info("self-update disabled");
}

const shutdown = () => {
  log.info("shutting down");
  client.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
