import type { NexusConfig } from "@nexus/config";
import type { DbConnection } from "@nexus/database";
import type { NexusSettings } from "@nexus/types";
import { createLogger, type Logger } from "@nexus/logger";
import type { AgentHub } from "./agents/hub";

export interface AppContext {
  config: NexusConfig;
  db: DbConnection;
  logger: Logger;
  hub: AgentHub;
  settings: () => Promise<NexusSettings>;
  /** current user id + requestId for audit/observability (set per request) */
  audit: (entry: {
    action: string;
    resourceType: string;
    resourceId?: string | null;
    resourceName?: string | null;
    serverId?: string | null;
    metadata?: Record<string, unknown> | null;
  }) => Promise<void>;
  notify: (type: string, title: string, message: string) => Promise<void>;
}

export const contextLogger = createLogger("api");
