import type { Context, Next } from "hono";
import { newRequestId } from "../lib/http";

export async function requestContext(c: Context, next: Next): Promise<void> {
  c.set("requestId", newRequestId());
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  if (ms > 1000) {
    const logger = c.get("logger");
    logger?.warn("slow request", { method: c.req.method, path: c.req.path, ms });
  }
}

export async function securityHeaders(c: Context, next: Next): Promise<void> {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-XSS-Protection", "0");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
}
