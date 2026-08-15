import { createLogger } from "@nexus/logger";
import type { DashboardEvent } from "@nexus/types";

const log = createLogger("api:events");

type Listener = (event: DashboardEvent) => void;

/** Broadcast hub: producers emit, dashboard sockets subscribe. */
class EventHub {
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: DashboardEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        log.error("event listener failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  broadcast(event: DashboardEvent): void {
    this.emit(event);
  }
}

export const eventHub = new EventHub();
