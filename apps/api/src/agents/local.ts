import { createLogger } from "@nexus/logger";
import type { DbConnection, ServerRow } from "@nexus/database";
import { decrypt } from "../lib/crypto";
import type { NexusConfig } from "@nexus/config";

const log = createLogger("api:local-agent");

/**
 * Spawns the local NEXUS Agent as a child process when a Local Server exists.
 * The Agent connects back over WebSocket like any remote agent — the local
 * server is not special-cased beyond the process spawn.
 */
export class LocalAgentLauncher {
  private proc: Bun.Subprocess | null = null;

  constructor(
    private readonly db: DbConnection,
    private readonly config: NexusConfig,
  ) {}

  async start(): Promise<void> {
    if (!this.config.localAgent.enabled) {
      log.info("local agent disabled (LOCAL_AGENT_ENABLED=false)");
      return;
    }
    const server = await this.db.get<ServerRow>(`SELECT * FROM servers WHERE type = 'local' LIMIT 1`);
    if (!server) {
      log.info("no local server configured yet — waiting for setup");
      return;
    }
    if (!server.agent_token_encrypted) {
      log.warn("local server has no agent token — run setup or reconnect");
      return;
    }
    const token = decrypt(server.agent_token_encrypted, this.config.encryptionKey);

    // Agent entry: prefer a prebuilt bundle, else run the source directly.
    const bundlePath = `${import.meta.dir}/../../../../apps/agent/dist/agent.js`;
    const srcPath = `${import.meta.dir}/../../../../apps/agent/src/index.ts`;
    const entry = (await Bun.file(bundlePath).exists()) ? bundlePath : srcPath;
    if (!(await Bun.file(entry).exists())) {
      log.warn("agent entry not found — local agent will not start", { entry });
      return;
    }

    log.info("starting local agent", { serverId: server.id, entry });
    this.proc = Bun.spawn(["bun", entry], {
      env: {
        ...process.env,
        AGENT_TOKEN: token,
        AGENT_SERVER_ID: server.id,
        AGENT_API_URL: this.config.agentApiUrl,
        AGENT_VERSION: server.agent_version ?? "0.1.0",
        AGENT_DATA_DIR: `${import.meta.dir}/../../../../data/agent`,
        DOCKER_HOST: this.config.dockerHost ?? "",
        LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
      },
      stdout: "inherit",
      stderr: "inherit",
    });

    this.proc.exited.then((code) => {
      log.warn("local agent exited", { code });
      this.proc = null;
    }).catch(() => {});
  }

  stop(): void {
    if (this.proc) {
      log.info("stopping local agent");
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
  }
}
