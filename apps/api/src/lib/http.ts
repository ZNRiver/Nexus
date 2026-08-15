import type { Context } from "hono";
import type { Page } from "@nexus/types";

export function ok<T>(c: Context, data: T, status = 200): Response {
  return c.json({ success: true, ...(data as object) }, status as never);
}

export function fail(c: Context, message: string, status = 400): Response {
  return c.json({ success: false, error: message }, status as never);
}

export interface PageQuery {
  limit: number;
  cursor?: string;
}

export function parsePageQuery(c: Context): PageQuery {
  const limitRaw = c.req.query("limit");
  const limit = Math.min(200, Math.max(1, parseInt(limitRaw ?? "50", 10) || 50));
  return { limit, cursor: c.req.query("cursor") || undefined };
}

export function makePage<T>(items: T[], limit: number, getCursor: (item: T) => string): Page<T> {
  const hasMore = items.length > limit;
  const pageItems = hasMore ? items.slice(0, limit) : items;
  const last = pageItems[pageItems.length - 1];
  return {
    items: pageItems,
    nextCursor: hasMore && last ? getCursor(last) : null,
  };
}

/** Simple created-at cursor: fetch limit+1 rows ordered by created_at desc. */
export function parseCreatedAtCursor(cursor?: string): string | null {
  return cursor && /^\d{4}-\d{2}-\d{2}T/.test(cursor) ? cursor : null;
}

let requestCounter = 0;

export function newRequestId(): string {
  requestCounter = (requestCounter + 1) % 1_000_000;
  return `req_${Date.now().toString(36)}_${requestCounter.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return c.env?.ip ?? "unknown";
}

/** Non-optional route param (Hono types untyped routes as `string | undefined`). */
export function pid(c: Context, name = "id"): string {
  return c.req.param(name) ?? "";
}
