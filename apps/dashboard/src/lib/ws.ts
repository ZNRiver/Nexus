import type { DashboardEvent } from "@nexus/types";

type Listener = (event: DashboardEvent) => void;

let ws: WebSocket | null = null;
let listeners = new Set<Listener>();
let reconnectListeners = new Set<() => void>();
let reconnectAttempts = 0;
let stopped = false;

function connect(): void {
  if (stopped || (ws && ws.readyState === WebSocket.OPEN)) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws/dashboard`);
  ws.onopen = () => {
    reconnectAttempts = 0;
    for (const cb of reconnectListeners) {
      try {
        cb();
      } catch {
        /* listener error */
      }
    }
  };
  ws.onmessage = (ev) => {
    try {
      const event = JSON.parse(ev.data as string) as DashboardEvent;
      for (const l of listeners) {
        try {
          l(event);
        } catch {
          /* listener error */
        }
      }
    } catch {
      /* malformed frame */
    }
  };
  ws.onclose = () => {
    ws = null;
    if (!stopped) {
      const delay = Math.min(15000, 1000 * 2 ** reconnectAttempts);
      reconnectAttempts++;
      setTimeout(connect, delay);
    }
  };
}

export function subscribeDashboard(listener: Listener): () => void {
  listeners.add(listener);
  connect();
  return () => listeners.delete(listener);
}

/**
 * Register a callback fired every time the socket opens (initial connect AND
 * every reconnect) so consumers can re-send subscriptions / re-sync state.
 */
export function onDashboardReconnect(cb: () => void): () => void {
  reconnectListeners.add(cb);
  return () => reconnectListeners.delete(cb);
}

/** Send a frame to the API (dropped silently until the socket is open — rely
 *  on onDashboardReconnect to re-send subscriptions after connecting). */
export function sendDashboard(msg: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

export function closeDashboard(): void {
  stopped = true;
  ws?.close();
  ws = null;
  listeners.clear();
  reconnectListeners.clear();
}
