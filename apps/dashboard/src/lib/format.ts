export function formatBytes(bytes: number | null | undefined, decimals = 1): string {
  if (bytes == null || isNaN(bytes) || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${parseFloat((bytes / k ** i).toFixed(decimals))} ${sizes[i]}`;
}

export function formatPercent(v: number | null | undefined): string {
  if (v == null || isNaN(v)) return "—";
  return `${v.toFixed(1)}%`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "—";
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function durationMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export function shortId(id: string | null | undefined): string {
  if (!id) return "—";
  return id.length > 14 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

export function relativeDuration(isoStart: string | null, isoEnd?: string | null): string {
  if (!isoStart) return "—";
  const end = isoEnd ? new Date(isoEnd).getTime() : Date.now();
  return durationMs(end - new Date(isoStart).getTime());
}
