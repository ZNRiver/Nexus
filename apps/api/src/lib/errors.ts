import type { Context } from "hono";

export type ErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "SERVER_OFFLINE"
  | "AGENT_NOT_INSTALLED"
  | "SERVER_ERROR"
  | "SETUP_INCOMPLETE"
  | "SETUP_ALREADY_COMPLETE"
  | "BAD_REQUEST";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const errors = {
  unauthorized: (msg = "Authentication required") => new AppError("UNAUTHORIZED", msg, 401),
  forbidden: (msg = "You do not have permission to perform this action") => new AppError("FORBIDDEN", msg, 403),
  notFound: (msg = "Resource not found") => new AppError("NOT_FOUND", msg, 404),
  validation: (details: unknown, msg = "Invalid input") => new AppError("VALIDATION_ERROR", msg, 422, details),
  conflict: (msg = "Conflict") => new AppError("CONFLICT", msg, 409),
  rateLimited: (msg = "Too many requests") => new AppError("RATE_LIMITED", msg, 429),
  serverOffline: (msg = "The selected server is offline") => new AppError("SERVER_OFFLINE", msg, 409),
  agentNotInstalled: (msg = "NEXUS Agent is not installed on this server") => new AppError("AGENT_NOT_INSTALLED", msg, 409),
  serverError: (msg = "Internal server error") => new AppError("SERVER_ERROR", msg, 500),
  badRequest: (msg = "Bad request") => new AppError("BAD_REQUEST", msg, 400),
};

export function sendError(c: Context, err: unknown): Response {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as never);
  }
  const message = err instanceof Error ? err.message : "Internal server error";
  const e = errors.serverError(message);
  return c.json({ error: { code: e.code, message: e.message } }, e.status as never);
}
