import { createLogger } from "@nexus/logger";
import type { DatabaseCreatePayload } from "@nexus/types";
import { DockerService } from "../docker/service";

const log = createLogger("agent:databases");

export async function createDatabaseContainer(
  docker: DockerService,
  payload: DatabaseCreatePayload,
  onLog?: (msg: string) => void,
): Promise<{ containerId: string }> {
  const logLine = onLog ?? (() => {});
  logLine(`Creating database container ${payload.containerName} (${payload.image})…`);
  await docker.volumeCreate(payload.volumeName);

  const labels = [`nexus.database=${payload.databaseId}`, "nexus.managed=true", "nexus.type=database", ...Object.entries(payload.labels).map(([k, v]) => `${k}=${v}`)];

  const args = [
    "run", "-d",
    "--name", payload.containerName,
    "-p", `${payload.hostPort}:${payload.internalPort}`,
    "-v", `${payload.volumeName}:${payload.volumePath}`,
    "--restart", "unless-stopped",
    ...(payload.memoryBytes ? ["-m", `${payload.memoryBytes}b`] : []),
    ...(payload.cpuLimit ? ["--cpus", String(payload.cpuLimit)] : []),
    ...labels.flatMap((l) => ["-l", l]),
    ...Object.entries(payload.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    payload.image,
  ];

  const res = await docker.run(args, { timeoutMs: 60000 });
  if (res.code !== 0) {
    // A failed `docker run` may still leave a container behind (e.g. port bind
    // failure happens after the container is created). Remove it so a retry
    // with another port doesn't hit "container name already in use".
    await docker.remove(payload.containerName, { force: true }).catch(() => {});
    throw new Error(`database container failed to start: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  const containerId = res.stdout.trim();
  logLine(`Database container started (${containerId})`);
  return { containerId };
}
