import type { Hono } from "hono";
import type { DbConnection } from "@nexus/database";
import type { Logger } from "@nexus/logger";
import type { AppContext } from "./context";
import type { AuthUser } from "./middleware/auth";

export interface AppVariables {
  db: DbConnection;
  logger: Logger;
  requestId: string;
  user?: AuthUser;
  ctx: AppContext;
}

export type App = Hono<{ Variables: AppVariables }>;
