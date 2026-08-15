import { createLogger } from "@nexus/logger";
import type { GameCreatePayload } from "@nexus/types";
import { DockerService } from "../docker/service";

const log = createLogger("agent:games");

export async function createGameContainer(
  docker: DockerService,
  payload: GameCreatePayload,
  onLog?: (msg: string) => void,
): Promise<{ containerId: string }> {
  const logLine = onLog ?? (() => {});
  logLine(`Creating game server container ${payload.containerName} (${payload.image})…`);
  await docker.volumeCreate(payload.volumeName);

  const labels = [
    `nexus.game=${payload.gameServerId}`,
    `nexus.managed=true`,
    `nexus.type=game`,
    ...Object.entries(payload.labels).map(([k, v]) => `${k}=${v}`),
  ];

  const args = [
    "run",
    "-d",
    "--name", payload.containerName,
    "-p", `${payload.port}:25565`,
    "-v", `${payload.volumeName}:/data`,
    "--restart", payload.restartPolicy,
    "-m", `${payload.memoryBytes}b`,
    ...(payload.cpuLimit ? ["--cpus", String(payload.cpuLimit)] : []),
    ...labels.flatMap((l) => ["-l", l]),
    ...Object.entries(payload.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    payload.image,
  ];

  // The image pull happens inside `docker run` and Minecraft images are large,
  // so allow up to 10 minutes for the first boot.
  const res = await docker.run(args, { timeoutMs: 10 * 60 * 1000 });
  if (res.code !== 0) {
    throw new Error(`game server container failed to start: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  const containerId = res.stdout.trim();
  logLine(`Game server container started (${containerId})`);
  return { containerId };
}

export async function startGame(docker: DockerService, containerId: string): Promise<void> {
  await docker.start(containerId);
}

export async function stopGame(docker: DockerService, containerId: string): Promise<void> {
  await docker.stop(containerId, 30);
}

export async function removeGame(docker: DockerService, containerId: string): Promise<void> {
  await docker.remove(containerId, { force: true, volumes: false });
}
