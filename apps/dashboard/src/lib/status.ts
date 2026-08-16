/**
 * Status helpers — the single place that decides whether a server's reported
 * state can be trusted as *live*. The API persists the last heartbeat's metrics
 * and statuses, so the UI must never present those as current when the host is
 * not actually connected. Everything here is derived from real backend data
 * (server.status + server.lastHeartbeatAt); nothing is mocked.
 */

const HEARTBEAT_FRESH_MS = 90_000; // watchdog flips OFFLINE after 45s — allow slack

export interface HostLike {
  status?: string | null;
  lastHeartbeatAt?: string | null;
  /** Raw snake_case row (SELECT * FROM servers) returned by some detail endpoints. */
  last_heartbeat_at?: string | null;
}

/**
 * The heartbeat timestamp may come camelCased (public server objects) or as the
 * raw DB column (detail endpoints that do `SELECT * FROM servers`).
 */
function heartbeatAt(server: HostLike): string | null {
  return server.lastHeartbeatAt ?? server.last_heartbeat_at ?? null;
}

/** A host is "live" only when the API says ONLINE *and* it is still heartbeating. */
export function isServerLive(server: HostLike | null | undefined): boolean {
  if (!server) return false;
  if (server.status !== "ONLINE") return false;
  const hb = heartbeatAt(server);
  if (!hb) return false;
  const age = Date.now() - new Date(hb).getTime();
  if (isNaN(age) || age < 0 || age > HEARTBEAT_FRESH_MS) return false;
  return true;
}

/** Human label for a non-live host (drives offline banners/empty states). */
export function serverUnavailableReason(server: HostLike | null | undefined): string {
  if (!server) return "Host status unknown";
  switch (server.status) {
    case "OFFLINE":
      return "Server is offline — no live data";
    case "ERROR":
      return "Server is in an error state — no live data";
    case "INSTALLING":
      return "Server is still being provisioned — no live data yet";
    case "MAINTENANCE":
      return "Server is in maintenance — no live data";
    default:
      return "No live data available";
  }
}

/** Stable status value for a resource whose host is not live (never "RUNNING"). */
export function hostAwareStatus(host: HostLike | null | undefined, resourceStatus?: string | null): string {
  if (!isServerLive(host)) return "UNKNOWN";
  return resourceStatus ?? "UNKNOWN";
}
