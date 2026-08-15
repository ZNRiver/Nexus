import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Terminal } from "lucide-react";
import { get } from "@/lib/api";
import { subscribeDashboard } from "@/lib/ws";
import { cn } from "@/lib/utils";
import type { ResourceLogEntry } from "@nexus/types";

export type ResourceLogType = "database" | "application" | "backup" | "game";

/**
 * Dark terminal-style panel that streams operation progress for a resource
 * (database create/deploy, application deploy, backups/restores). Polls the
 * REST endpoint on mount and appends `resource.log` WS events in real time.
 */
export function OperationLogPanel({
  resourceType,
  resourceId,
  title = "Deployment Logs",
  subtitle = "Details of the request log entry.",
  className,
  autoFollow = true,
}: {
  resourceType: ResourceLogType;
  resourceId: string;
  title?: string;
  subtitle?: string;
  className?: string;
  autoFollow?: boolean;
}) {
  const queryClient = useQueryClient();
  const [lines, setLines] = useState<ResourceLogEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const resourceKey = `${resourceType}:${resourceId}`;

  const { isLoading } = useQuery({
    queryKey: ["resource-logs", resourceType, resourceId],
    queryFn: () =>
      get<{ items: ResourceLogEntry[] }>(`/resources/${resourceType}/${resourceId}/logs`).then((r) => {
        setLines(r.items);
        return r.items;
      }),
    refetchInterval: 4000,
    enabled: !!resourceId,
  });

  // Live WS updates — append lines for this resource.
  useEffect(() => {
    const unsub = subscribeDashboard((event) => {
      if (event.type === "resource.log" && event.resourceType === resourceType && event.resourceId === resourceId) {
        setLines((prev) => {
          if (prev.some((l) => l.id === event.entry.id)) return prev;
          return [...prev, event.entry];
        });
        queryClient.invalidateQueries({ queryKey: ["resource-logs", resourceType, resourceId] });
      }
    });
    return unsub;
  }, [resourceType, resourceId, queryClient]);

  // Always keep the newest line visible.
  useEffect(() => {
    if (!autoFollow) return;
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines.length, autoFollow]);

  const stats = useMemo(() => {
    const total = lines.length;
    const stderr = lines.filter((l) => l.stream === "stderr").length;
    return { total, stderr };
  }, [lines]);

  return (
    <div className={cn("flex min-h-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-[#0a0a0b]", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Terminal className="size-3.5" />
          </span>
          <div>
            <p className="text-sm font-semibold leading-tight">{title}</p>
            <p className="text-[11px] leading-tight text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        {isLoading ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            {stats.total > 0 && <span>{stats.total} lines</span>}
            {stats.stderr > 0 && <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-red-400">{stats.stderr} errors</span>}
          </div>
        )}
      </div>
      <LogTerminal ref={scrollRef} lines={lines} />
    </div>
  );
}

/** The actual scrollable terminal body with timestamp + level badges per line. */
export const LogTerminal = forwardRef<HTMLDivElement, { lines: ResourceLogEntry[] }>(({ lines }, ref) => {
  if (lines.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-10 text-center text-xs text-muted-foreground">
        Waiting for progress… the operation logs will appear here live.
      </div>
    );
  }
  return (
    <div ref={ref} className="max-h-[380px] min-h-[160px] flex-1 overflow-auto p-3 font-mono text-[11.5px] leading-relaxed">
      {lines.map((l) => (
        <div key={l.id} className="group flex items-start gap-2.5 rounded px-1.5 py-0.5 transition-colors hover:bg-white/[0.04]">
          <span
            className={cn(
              "mt-[1px] inline-flex shrink-0 items-center rounded px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide",
              l.stream === "stderr"
                ? "bg-red-500/10 text-red-400"
                : l.stream === "system"
                  ? "bg-sky-500/10 text-sky-400"
                  : "bg-emerald-500/10 text-emerald-400",
            )}
          >
            {l.stream === "stderr" ? "error" : l.stream === "system" ? "info" : "success"}
          </span>
          <span
            className={cn(
              "min-w-0 flex-1 break-words",
              l.stream === "stderr" ? "text-red-300/90" : l.stream === "system" ? "text-sky-200/80" : "text-zinc-200/90",
            )}
          >
            {l.message}
          </span>
          <span className="shrink-0 select-none text-[10px] text-zinc-600">{new Date(l.timestamp).toLocaleTimeString()}</span>
        </div>
      ))}
    </div>
  );
});
