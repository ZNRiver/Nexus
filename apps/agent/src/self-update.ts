import { createHash } from "node:crypto";
import { chmodSync, existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLogger } from "@nexus/logger";
import type { AgentConfig } from "./config";

const log = createLogger("agent:update");

export interface SelfUpdateState {
  checking: boolean;
  lastCheckedAt?: string;
  lastError?: string;
  lastUpgradedAt?: string;
  /** sha256 of the bundle file this process is actually running */
  runningSha256?: string | null;
}

/**
 * The agent is a single-file Bun bundle run by systemd (`Restart=always`). To
 * self-update we: 1) ask the API for the SHA-256 of the current bundle, 2) if
 * it differs from the running file, download the new bundle to `<agent>.new`,
 * 3) atomically rename it over the running file, 4) exit — systemd restarts
 * the service and the new bundle takes over.
 */
export class SelfUpdater {
  private state: SelfUpdateState = { checking: false };
  private readonly agentFile: string;

  constructor(
    private readonly config: AgentConfig,
    private readonly dataDir: string,
  ) {
    // The bundle lives next to the data dir (AGENT_DATA_DIR/../agent.js).
    this.agentFile = join(dirname(dataDir), "agent.js");
  }

  getStatus(): SelfUpdateState {
    return this.state;
  }

  /** SHA-256 of the currently running bundle file. */
  private async localSha256Async(): Promise<string | null> {
    try {
      if (!existsSync(this.agentFile)) return null;
      const buf = Buffer.from(await Bun.file(this.agentFile).arrayBuffer());
      return createHash("sha256").update(buf).digest("hex");
    } catch {
      return null;
    }
  }

  /** Fetch the bundle metadata (SHA-256 + size) from the API. */
  private async fetchRemoteInfo(): Promise<{ sha256: string; size: number } | null> {
    const url = `${this.config.apiUrl.replace(/\/$/, "")}/api/v1/agent/self-update` +
      `?token=${encodeURIComponent(this.config.token)}&serverId=${encodeURIComponent(this.config.serverId)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`update check failed (HTTP ${res.status})`);
    const body = (await res.json()) as { success?: boolean; sha256: string; size: number };
    if (!body.sha256) throw new Error("update check returned no sha256");
    return { sha256: body.sha256, size: body.size };
  }

  /** Download the fresh bundle from the API. */
  private async downloadBundle(): Promise<Buffer> {
    const url = `${this.config.apiUrl.replace(/\/$/, "")}/api/v1/agent/bundle` +
      `?token=${encodeURIComponent(this.config.token)}&serverId=${encodeURIComponent(this.config.serverId)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`bundle download failed (HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error("downloaded bundle is empty");
    return buf;
  }

  /**
   * Check for an update and apply it if available. Safe to call repeatedly —
   * skips while a check is already in flight.
   */
  async checkAndUpdate(): Promise<"up-to-date" | "upgraded" | "skipped" | "error"> {
    if (this.state.checking) return "skipped";
    this.state.checking = true;
    this.state.lastCheckedAt = new Date().toISOString();
    try {
      const remote = await this.fetchRemoteInfo();
      if (!remote) return "error";

      const local = await this.localSha256Async();
      this.state.runningSha256 = local;
      if (local === remote.sha256) {
        log.info("agent is up to date", { sha256: local?.slice(0, 12) });
        this.state.lastError = undefined;
        return "up-to-date";
      }

      log.info("update available — downloading new bundle", {
        local: local?.slice(0, 12),
        remote: remote.sha256.slice(0, 12),
      });
      const bundle = await this.downloadBundle();
      const downloaded = createHash("sha256").update(bundle).digest("hex");
      if (downloaded !== remote.sha256) {
        throw new Error(`bundle integrity check failed (got ${downloaded.slice(0, 12)}, expected ${remote.sha256.slice(0, 12)})`);
      }

      const tmpFile = `${this.agentFile}.new`;
      await Bun.write(tmpFile, bundle);
      chmodSync(tmpFile, 0o755);
      renameSync(tmpFile, this.agentFile);
      this.state.lastUpgradedAt = new Date().toISOString();
      this.state.lastError = undefined;
      log.info("new bundle installed — restarting to apply", { sha256: downloaded.slice(0, 12) });

      // Give the WS a moment to flush, then exit — systemd restarts us.
      setTimeout(() => {
        log.info("self-update: exiting for restart");
        process.exit(0);
      }, 500);
      return "upgraded";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.state.lastError = message;
      log.warn("self-update check failed", { error: message });
      return "error";
    } finally {
      this.state.checking = false;
    }
  }
}
