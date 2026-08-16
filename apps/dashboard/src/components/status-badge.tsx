import { cn } from "@/lib/utils";

const STATUS_COLORS: Record<string, { dot: string; text: string; bg: string }> = {
  ONLINE: { dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/30" },
  RUNNING: { dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/30" },
  SUCCESS: { dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/30" },
  ACTIVE: { dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/30" },
  HEALTHY: { dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/30" },
  OFFLINE: { dot: "bg-muted-foreground/70", text: "text-muted-foreground", bg: "bg-muted/60 border-border/60" },
  DISCONNECTED: { dot: "bg-muted-foreground/70", text: "text-muted-foreground", bg: "bg-muted/60 border-border/60" },
  STOPPED: { dot: "bg-muted-foreground/70", text: "text-muted-foreground", bg: "bg-muted/60 border-border/60" },
  NOT_DEPLOYED: { dot: "bg-muted-foreground/70", text: "text-muted-foreground", bg: "bg-muted/60 border-border/60" },
  UNKNOWN: { dot: "bg-muted-foreground/50", text: "text-muted-foreground/80", bg: "bg-muted/40 border-dashed border-border/70" },
  UNAVAILABLE: { dot: "bg-muted-foreground/50", text: "text-muted-foreground/80", bg: "bg-muted/40 border-dashed border-border/70" },
  QUEUED: { dot: "bg-sky-500", text: "text-sky-600 dark:text-sky-400", bg: "bg-sky-500/10 border-sky-500/30" },
  PENDING: { dot: "bg-sky-500", text: "text-sky-600 dark:text-sky-400", bg: "bg-sky-500/10 border-sky-500/30" },
  CONNECTING: { dot: "bg-sky-500", text: "text-sky-600 dark:text-sky-400", bg: "bg-sky-500/10 border-sky-500/30" },
  INSTALLING: { dot: "bg-sky-500", text: "text-sky-600 dark:text-sky-400", bg: "bg-sky-500/10 border-sky-500/30" },
  CREATING: { dot: "bg-sky-500", text: "text-sky-600 dark:text-sky-400", bg: "bg-sky-500/10 border-sky-500/30" },
  STARTING: { dot: "bg-sky-500", text: "text-sky-600 dark:text-sky-400", bg: "bg-sky-500/10 border-sky-500/30" },
  CLONING: { dot: "bg-sky-500", text: "text-sky-600 dark:text-sky-400", bg: "bg-sky-500/10 border-sky-500/30" },
  BUILDING: { dot: "bg-sky-500", text: "text-sky-600 dark:text-sky-400", bg: "bg-sky-500/10 border-sky-500/30" },
  PUSHING: { dot: "bg-sky-500", text: "text-sky-600 dark:text-sky-400", bg: "bg-sky-500/10 border-sky-500/30" },
  DEPLOYING: { dot: "bg-sky-500", text: "text-sky-600 dark:text-sky-400", bg: "bg-sky-500/10 border-sky-500/30" },
  HEALTH_CHECK: { dot: "bg-sky-500", text: "text-sky-600 dark:text-sky-400", bg: "bg-sky-500/10 border-sky-500/30" },
  WAITING_FOR_SERVER: { dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", bg: "bg-amber-500/10 border-amber-500/30" },
  UNHEALTHY: { dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", bg: "bg-amber-500/10 border-amber-500/30" },
  FAILED: { dot: "bg-red-500", text: "text-red-600 dark:text-red-400", bg: "bg-red-500/10 border-red-500/30" },
  ERROR: { dot: "bg-red-500", text: "text-red-600 dark:text-red-400", bg: "bg-red-500/10 border-red-500/30" },
  CANCELLED: { dot: "bg-muted-foreground/70", text: "text-muted-foreground", bg: "bg-muted/60 border-border/60" },
  REMOVING: { dot: "bg-muted-foreground/70", text: "text-muted-foreground", bg: "bg-muted/60 border-border/60" },
  MAINTENANCE: { dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", bg: "bg-amber-500/10 border-amber-500/30" },
  DISABLED: { dot: "bg-muted-foreground/70", text: "text-muted-foreground", bg: "bg-muted/60 border-border/60" },
  PENDING_SSL: { dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", bg: "bg-amber-500/10 border-amber-500/30" },
};

export function StatusDot({ status, className }: { status: string; className?: string }) {
  const c = STATUS_COLORS[status] ?? { dot: "bg-muted-foreground/70" };
  return <span className={cn("inline-block size-1.5 rounded-full", c.dot, className)} />;
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const c = STATUS_COLORS[status] ?? { dot: "bg-muted-foreground/70", text: "text-muted-foreground", bg: "bg-muted/60 border-border/60" };
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider", c.bg, c.text, className)}>
      <span className={cn("size-1.5 rounded-full", c.dot)} />
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function StatusPill({ status, className }: { status: string; className?: string }) {
  const c = STATUS_COLORS[status] ?? { dot: "bg-muted-foreground/70", text: "text-muted-foreground" };
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", c.text, className)}>
      <span className={cn("size-2 rounded-full", c.dot, status === "ONLINE" || status === "RUNNING" ? "animate-pulse" : "")} />
      {status.replace(/_/g, " ")}
    </span>
  );
}

/**
 * Small destructive/amber tag shown next to a resource when its host server is
 * not live — the resource's own status cannot be trusted while the host is
 * disconnected, and the UI must say so instead of implying everything is fine.
 */
export function HostOfflineTag({ status, className }: { status?: string | null; className?: string }) {
  if (!status || status === "ONLINE") return null;
  const label = status === "ERROR" ? "host error" : status === "INSTALLING" ? "host installing" : status === "MAINTENANCE" ? "host maintenance" : "host offline";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-destructive/25 bg-destructive/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-destructive",
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-destructive/70" />
      {label}
    </span>
  );
}
