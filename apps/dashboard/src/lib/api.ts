import type { ApiErrorBody } from "@nexus/types";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T = unknown>(path: string, opts: RequestInit & { query?: Record<string, string | undefined> } = {}): Promise<T> {
  const { query, ...init } = opts;
  let url = `/api/v1${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v) params.set(k, v);
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }
  const res = await fetch(url, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as (T & ApiErrorBody) | ApiErrorBody;
  if (!res.ok) {
    const err = (body as ApiErrorBody).error;
    throw new ApiError(res.status, err?.code ?? "UNKNOWN", err?.message ?? `Request failed (${res.status})`);
  }
  return body as T;
}

type Query = Record<string, string | undefined>;
export const get = <T>(path: string, query?: Query) => api<T>(path, { query });
export const post = <T>(path: string, body?: unknown, query?: Query) => api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body), query });
export const patch = <T>(path: string, body?: unknown, query?: Query) => api<T>(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body), query });
export const put = <T>(path: string, body?: unknown, query?: Query) => api<T>(path, { method: "PUT", body: body === undefined ? undefined : JSON.stringify(body), query });
export const del = <T>(path: string, query?: Query) => api<T>(path, { method: "DELETE", query });

/** Download a backup file (streamed from the agent host) as a browser download. */
export async function downloadBackup(backupId: string, fallbackName = "backup"): Promise<void> {
  const res = await fetch(`/api/v1/backups/${backupId}/download`, { credentials: "include" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as ApiErrorBody;
    throw new ApiError(res.status, body.error?.code ?? "UNKNOWN", body.error?.message ?? `Download failed (${res.status})`);
  }
  const blob = await res.blob();
  // Try to honour the server-provided filename.
  let fileName = fallbackName;
  const disposition = res.headers.get("content-disposition");
  const match = disposition?.match(/filename\*?=(?:UTF-8''|\")?([^";]+)/i);
  if (match?.[1]) fileName = decodeURIComponent(match[1].replace(/"/g, ""));
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
