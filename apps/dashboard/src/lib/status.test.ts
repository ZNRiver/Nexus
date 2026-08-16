import { describe, expect, test } from "bun:test";
import { isServerLive, serverUnavailableReason, hostAwareStatus, type HostLike } from "./status";

const MINUTE = 60_000;
const recent = (ms = 10_000) => new Date(Date.now() - ms).toISOString();

/**
 * Raw `SELECT * FROM servers` row — exactly what the detail endpoints
 * (applications/:id, databases/:id, game-servers/:id) return: snake_case
 * `last_heartbeat_at`, no camelCase fields.
 */
function rawRow(overrides: Partial<HostLike> = {}): Record<string, unknown> {
  return {
    id: "srv_123",
    name: "teste",
    status: "ONLINE",
    last_heartbeat_at: recent(),
    ...overrides,
  };
}

/** Public server object (camelCase) as returned by /servers and /servers/:id. */
function publicServer(overrides: Partial<HostLike> = {}): HostLike {
  return { status: "ONLINE", lastHeartbeatAt: recent(), ...overrides };
}

describe("isServerLive — raw snake_case rows from detail endpoints", () => {
  test("returns true for ONLINE with a fresh raw last_heartbeat_at", () => {
    expect(isServerLive(rawRow())).toBe(true);
  });

  test("returns true for ONLINE with a fresh camelCase lastHeartbeatAt", () => {
    expect(isServerLive(publicServer())).toBe(true);
  });

  test("returns true when the camelCase field is present alongside the raw one", () => {
    expect(isServerLive({ status: "ONLINE", lastHeartbeatAt: recent(), last_heartbeat_at: recent(200_000) })).toBe(true);
  });

  test("returns false when the heartbeat is older than the freshness window", () => {
    expect(isServerLive(rawRow({ last_heartbeat_at: recent(91_000) }))).toBe(false);
    expect(isServerLive(publicServer({ lastHeartbeatAt: recent(5 * MINUTE) }))).toBe(false);
  });

  test("returns false when there is no heartbeat at all", () => {
    expect(isServerLive(rawRow({ last_heartbeat_at: null }))).toBe(false);
    expect(isServerLive(rawRow({ last_heartbeat_at: undefined }))).toBe(false);
    expect(isServerLive(publicServer({ lastHeartbeatAt: null }))).toBe(false);
    expect(isServerLive({ status: "ONLINE" })).toBe(false);
  });

  test("returns false when the heartbeat is in the future (clock skew treated as invalid)", () => {
    expect(isServerLive(rawRow({ last_heartbeat_at: new Date(Date.now() + 60_000).toISOString() }))).toBe(false);
  });

  test("returns false when the heartbeat date is unparseable", () => {
    expect(isServerLive(rawRow({ last_heartbeat_at: "not-a-date" }))).toBe(false);
  });
});

describe("isServerLive — status gating", () => {
  test("only ONLINE is live, even with a fresh heartbeat", () => {
    for (const status of ["OFFLINE", "ERROR", "INSTALLING", "MAINTENANCE", "UNKNOWN", "PENDING", "PROVISIONING", null, undefined]) {
      expect(isServerLive(rawRow({ status }))).toBe(false);
      expect(isServerLive(publicServer({ status }))).toBe(false);
    }
  });

  test("returns false for null/undefined hosts", () => {
    expect(isServerLive(null)).toBe(false);
    expect(isServerLive(undefined)).toBe(false);
  });
});

describe("hostAwareStatus", () => {
  test("never reports a resource as RUNNING while its host is not live", () => {
    expect(hostAwareStatus(rawRow({ status: "OFFLINE" }), "RUNNING")).toBe("UNKNOWN");
    expect(hostAwareStatus(null, "RUNNING")).toBe("UNKNOWN");
  });

  test("passes through the real resource status when the host is live", () => {
    expect(hostAwareStatus(rawRow(), "RUNNING")).toBe("RUNNING");
    expect(hostAwareStatus(publicServer(), "STOPPED")).toBe("STOPPED");
  });

  test("falls back to UNKNOWN when no resource status is present", () => {
    expect(hostAwareStatus(publicServer(), null)).toBe("UNKNOWN");
  });
});

describe("serverUnavailableReason", () => {
  test("maps known statuses to clear messages", () => {
    expect(serverUnavailableReason({ status: "OFFLINE" })).toContain("offline");
    expect(serverUnavailableReason({ status: "ERROR" })).toContain("error");
    expect(serverUnavailableReason({ status: "INSTALLING" })).toContain("provisioned");
    expect(serverUnavailableReason({ status: "MAINTENANCE" })).toContain("maintenance");
  });

  test("never assumes online for unknown states", () => {
    const reason = serverUnavailableReason({ status: "UNKNOWN" });
    expect(reason).not.toMatch(/online/i);
    expect(serverUnavailableReason(null)).toContain("unknown");
  });
});
