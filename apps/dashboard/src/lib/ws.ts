import type { DashboardEvent } from "@nexus/types";

type Listener = (event: DashboardEvent) => void;

let ws: WebSocket | null = null;
let listeners = new Set<Listener>();
let reconnectAttempts = 0;
let stopped = false;

function connect(): void {
  if (stopped || (ws && ws.readyState === WebSocket.OPEN)) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws/dashboard`);
  ws.onopen = () => {
    reconnectAttempts = 0;
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

export function closeDashboard(): void {
  stopped = true;
  ws?.close();
  ws = null;
  listeners.clear();
}
