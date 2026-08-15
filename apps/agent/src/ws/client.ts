import { createLogger } from "@nexus/logger";
import type { AgentAction } from "@nexus/types";
import type { AgentConfig } from "../config";
import { dispatch, validateRequest, type HandlerContext } from "../handlers";
import { DockerService } from "../docker/service";

const log = createLogger("agent:ws");

export class AgentClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly config: AgentConfig) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private wsUrl(): string {
    const base = this.config.apiUrl.replace(/^http/, "ws").replace(/\/$/, "");
    return `${base}/ws/agent?token=${encodeURIComponent(this.config.token)}&serverId=${encodeURIComponent(this.config.serverId)}`;
  }

  connect(): void {
    if (this.stopped) return;
    const url = this.wsUrl();
    log.info("connecting to API", { url });
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      log.info("connected to API");
      this.startHeartbeat();
    };

    ws.onmessage = (ev) => {
      void this.handleMessage(String(ev.data));
    };

    ws.onclose = () => {
      log.warn("connection closed");
      this.stopHeartbeat();
      this.ws = null;
      if (!this.stopped) this.scheduleReconnect();
    };

    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect(): void {
    const delay = Math.min(30000, 1000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts++;
    log.info("scheduling reconnect", { delay });
    setTimeout(() => this.connect(), delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), this.config.heartbeatIntervalMs);
    void this.sendHeartbeat();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      const { collectMetrics } = await import("../system/info");
      const docker = new DockerService(this.config.dockerHost);
      const metrics = await collectMetrics({
        dockerPs: async () => {
          const containers = await docker.ps();
          const stats = await docker.statsAll();
          const running = containers.filter((c) => c.state === "running");
          return {
            running: running.length,
            total: containers.length,
            stats: running.map((c) => ({
              id: c.id,
              name: c.name,
              cpuPercent: stats[c.name]?.cpuPercent ?? 0,
              memoryUsageBytes: stats[c.name]?.memoryUsageBytes ?? 0,
              memoryLimitBytes: stats[c.name]?.memoryLimitBytes ?? 0,
            })),
          };
        },
      });
      // The connection may have closed while we awaited the metrics — re-check
      // before sending. Sending on a closed/null socket would crash the agent
      // and put systemd into a restart loop.
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify({ type: "heartbeat", serverId: this.config.serverId, metrics }));
    } catch (err) {
      log.warn("heartbeat failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleMessage(raw: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    const m = msg as Record<string, unknown>;

    if (m.type === "cancel") {
      const { requestCancel } = await import("../deployments/executor");
      const deploymentId = String((m as { deploymentId?: string }).deploymentId ?? "");
      if (deploymentId) {
        requestCancel(deploymentId);
        log.info("cancel requested", { deploymentId });
      }
      return;
    }

    const req = validateRequest(msg);
    if (!req) {
      log.warn("rejected invalid message", { raw: raw.slice(0, 200) });
      return;
    }

    log.debug("dispatch", { action: req.action, requestId: req.requestId });

    const ctx: HandlerContext = {
      docker: new DockerService(this.config.dockerHost),
      emitEvent: (eventType, resourceId, data) => {
        this.sendEvent(eventType, resourceId, data);
      },
      sendResult: (requestId, result) => {
        this.send({ type: "ack", requestId, result });
      },
      sendError: (requestId, code, message) => {
        this.send({ type: "error", requestId, error: { code, message } });
      },
    };

    // Long-running actions are dispatched without awaiting so the WS loop
    // stays responsive (heartbeats + cancels keep flowing).
    void dispatch(req, ctx);
  }

  private sendEvent(eventType: string, resourceId: string | undefined, data: Record<string, unknown>): void {
    this.send({ type: "event", event: { type: eventType, resourceId, data, timestamp: new Date().toISOString() } });
  }

  private send(msg: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  stop(): void {
    this.stopped = true;
    this.stopHeartbeat();
    this.ws?.close();
  }
}
