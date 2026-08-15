import type { DockerService } from "./service";

/**
 * Registry of active `docker logs -f` streams, keyed by the streamId the API
 * assigned. Lines are emitted as `container.log` events; the follow process
 * dies when the container stops/restarts, and the registry lets us stop it
 * explicitly when the last dashboard subscriber leaves.
 */
interface ActiveStream {
  stop: () => void;
}

const streams = new Map<string, ActiveStream>();

export function startContainerLogFollow(
  docker: DockerService,
  payload: { id: string; streamId: string; tail?: number },
  onLine: (streamId: string, line: string) => void,
  onEnd: (streamId: string) => void,
): void {
  // Replace any previous follow for the same stream (idempotent subscribe).
  stopContainerLogFollow(payload.streamId);

  let ended = false;
  const handle = docker.followLogs(
    payload.id,
    payload.tail ?? 200,
    (line) => onLine(payload.streamId, line),
    () => {
      if (ended) return;
      ended = true;
      streams.delete(payload.streamId);
      onEnd(payload.streamId);
    },
  );
  streams.set(payload.streamId, {
    stop: () => {
      if (ended) return;
      ended = true;
      streams.delete(payload.streamId);
      handle.stop();
    },
  });
}

export function stopContainerLogFollow(streamId: string): boolean {
  const s = streams.get(streamId);
  if (!s) return false;
  s.stop();
  return true;
}

export function stopAllContainerLogFollows(): void {
  for (const [, s] of streams) s.stop();
  streams.clear();
}
