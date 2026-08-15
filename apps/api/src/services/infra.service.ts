import type { DbConnection, ServerRow } from "@nexus/database";
import { errors } from "../lib/errors";
import type { ContainerInfo, ImageInfo, NetworkInfo, VolumeInfo } from "@nexus/types";
import type { AppContext } from "../context";

export class InfraService {
  constructor(
    private readonly db: DbConnection,
    private readonly ctx: AppContext,
  ) {}

  private async requireOnlineServer(serverId: string): Promise<ServerRow> {
    const server = await this.db.get<ServerRow>(`SELECT * FROM servers WHERE id = ?`, [serverId]);
    if (!server) throw errors.notFound("Server not found");
    if (!this.ctx.hub.isOnline(serverId)) throw errors.serverOffline();
    return server;
  }

  /** Containers across one server (or all online servers). */
  async containers(serverId?: string): Promise<{ serverId: string; containers: ContainerInfo[] }[]> {
    const servers = serverId
      ? [await this.requireOnlineServer(serverId)]
      : await this.db.all<ServerRow>(`SELECT * FROM servers WHERE status = 'ONLINE' ORDER BY name ASC`);
    const results: { serverId: string; containers: ContainerInfo[] }[] = [];
    for (const server of servers) {
      try {
        const containers = await this.ctx.hub.request(server.id, "docker.ps", {}) as ContainerInfo[];
        results.push({ serverId: server.id, containers });
      } catch (err) {
        if (serverId) throw err;
      }
    }
    return results;
  }

  async containerAction(serverId: string, containerId: string, action: "start" | "stop" | "restart" | "pause" | "unpause" | "remove", opts: { force?: boolean; volumes?: boolean; timeoutSeconds?: number } = {}): Promise<{ id: string }> {
    await this.requireOnlineServer(serverId);
    const result = await this.ctx.hub.request(serverId, `container.${action}` as never, { id: containerId, force: opts.force, volumes: opts.volumes, timeoutSeconds: opts.timeoutSeconds ?? 15 }) as { id: string };
    await this.ctx.audit({ action: `container.${action}`, resourceType: "container", resourceId: containerId, serverId });
    return result;
  }

  async containerLogs(serverId: string, containerId: string, tail = 300): Promise<string> {
    await this.requireOnlineServer(serverId);
    const result = await this.ctx.hub.request(serverId, "container.logs", { id: containerId, tail }) as { logs: string };
    return result.logs;
  }

  async containerInspect(serverId: string, containerId: string): Promise<unknown> {
    await this.requireOnlineServer(serverId);
    return this.ctx.hub.request(serverId, "docker.inspect", { id: containerId });
  }

  async containerExec(serverId: string, containerId: string, cmd: string[]): Promise<{ output: string; exitCode: number }> {
    await this.requireOnlineServer(serverId);
    const result = await this.ctx.hub.request(serverId, "container.exec", { id: containerId, cmd, timeoutMs: 30000, shell: true }) as { output: string; exitCode: number };
    await this.ctx.audit({ action: "container.exec", resourceType: "container", resourceId: containerId, serverId, metadata: { cmd } });
    return result;
  }

  async images(serverId?: string): Promise<{ serverId: string; images: ImageInfo[] }[]> {
    const servers = serverId
      ? [await this.requireOnlineServer(serverId)]
      : await this.db.all<ServerRow>(`SELECT * FROM servers WHERE status = 'ONLINE' ORDER BY name ASC`);
    const results: { serverId: string; images: ImageInfo[] }[] = [];
    for (const server of servers) {
      try {
        const images = await this.ctx.hub.request(server.id, "docker.images", {}) as ImageInfo[];
        results.push({ serverId: server.id, images });
      } catch (err) {
        if (serverId) throw err;
      }
    }
    return results;
  }

  async pullImage(serverId: string, image: string): Promise<{ image: string }> {
    await this.requireOnlineServer(serverId);
    const result = await this.ctx.hub.request(serverId, "image.pull", { image }, { timeoutMs: 10 * 60 * 1000 }) as { image: string };
    await this.ctx.audit({ action: "image.pull", resourceType: "image", resourceName: image, serverId });
    return result;
  }

  async removeImage(serverId: string, image: string, force = false): Promise<void> {
    await this.requireOnlineServer(serverId);
    await this.ctx.hub.request(serverId, "image.remove", { image, force });
    await this.ctx.audit({ action: "image.remove", resourceType: "image", resourceName: image, serverId });
  }

  async volumes(serverId?: string): Promise<{ serverId: string; volumes: VolumeInfo[] }[]> {
    const servers = serverId
      ? [await this.requireOnlineServer(serverId)]
      : await this.db.all<ServerRow>(`SELECT * FROM servers WHERE status = 'ONLINE' ORDER BY name ASC`);
    const results: { serverId: string; volumes: VolumeInfo[] }[] = [];
    for (const server of servers) {
      try {
        const volumes = await this.ctx.hub.request(server.id, "docker.volumes", {}) as VolumeInfo[];
        // enrich with usage
        const containers = await this.ctx.hub.request(server.id, "docker.ps", {}) as ContainerInfo[];
        for (const v of volumes) {
          v.usedBy = containers.filter((c) => c.volumes.includes(v.name) || c.labels?.["com.docker.compose.project"]).map((c) => c.name);
          try {
            const detail = await this.ctx.hub.request(server.id, "volume.inspect", { name: v.name }) as VolumeInfo;
            v.mountpoint = detail.mountpoint;
          } catch {
            /* ignore */
          }
        }
        results.push({ serverId: server.id, volumes });
      } catch (err) {
        if (serverId) throw err;
      }
    }
    return results;
  }

  async createVolume(serverId: string, name: string, driver?: string): Promise<{ name: string }> {
    await this.requireOnlineServer(serverId);
    const result = await this.ctx.hub.request(serverId, "volume.create", { name, driver }) as { name: string };
    await this.ctx.audit({ action: "volume.create", resourceType: "volume", resourceName: name, serverId });
    return result;
  }

  async removeVolume(serverId: string, name: string, force = false): Promise<void> {
    await this.requireOnlineServer(serverId);
    await this.ctx.hub.request(serverId, "volume.remove", { name, force });
    await this.ctx.audit({ action: "volume.delete", resourceType: "volume", resourceName: name, serverId });
  }

  async networks(serverId?: string): Promise<{ serverId: string; networks: NetworkInfo[] }[]> {
    const servers = serverId
      ? [await this.requireOnlineServer(serverId)]
      : await this.db.all<ServerRow>(`SELECT * FROM servers WHERE status = 'ONLINE' ORDER BY name ASC`);
    const results: { serverId: string; networks: NetworkInfo[] }[] = [];
    for (const server of servers) {
      try {
        const networks = await this.ctx.hub.request(server.id, "docker.networks", {}) as NetworkInfo[];
        for (const n of networks) {
          try {
            const detail = await this.ctx.hub.request(server.id, "network.inspect", { name: n.name }) as NetworkInfo;
            Object.assign(n, detail);
          } catch {
            /* ignore */
          }
        }
        results.push({ serverId: server.id, networks });
      } catch (err) {
        if (serverId) throw err;
      }
    }
    return results;
  }

  async createNetwork(serverId: string, name: string, driver = "bridge", subnet?: string): Promise<{ name: string }> {
    await this.requireOnlineServer(serverId);
    const result = await this.ctx.hub.request(serverId, "network.create", { name, driver, subnet }) as { name: string };
    await this.ctx.audit({ action: "network.create", resourceType: "network", resourceName: name, serverId });
    return result;
  }

  async removeNetwork(serverId: string, name: string): Promise<void> {
    await this.requireOnlineServer(serverId);
    await this.ctx.hub.request(serverId, "network.remove", { name });
    await this.ctx.audit({ action: "network.delete", resourceType: "network", resourceName: name, serverId });
  }
}
