import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { get } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { TableSkeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { timeAgo } from "@/lib/format";
import type { AuditLogEntry } from "@nexus/types";

export function AuditPage() {
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ["audit"], queryFn: () => get<{ items: AuditLogEntry[] }>("/audit", { limit: "50" }), refetchInterval: 15000 });
  return (
    <div className="p-4 sm:p-6">
      <PageHeader title="Audit Log" description="Every administrative action recorded with actor, resource and server." />

      {isLoading ? (
        <TableSkeleton rows={10} cols={4} />
      ) : !data?.items.length ? (
        <EmptyState icon={<ScrollText className="size-5" />} title="No activity" description="Actions such as deploys, server changes and settings updates will appear here." />
      ) : (
        <Card className="overflow-hidden">
          <div className="divide-y divide-border/50">
            {data.items.map((a) => (
              <div key={a.id} className="px-5 py-3">
                <button className="flex w-full items-center gap-4 text-start" onClick={() => setExpanded(expanded === a.id ? null : a.id)}>
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <ScrollText className="size-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{a.action.replace(/\./g, " · ")}</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {a.userName ?? "system"} · {a.resourceType} {a.resourceName ? `· ${a.resourceName}` : ""} · {timeAgo(a.createdAt)}
                    </p>
                  </div>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{a.serverId ? `sv:${a.serverId.slice(-6)}` : ""}</span>
                </button>
                {expanded === a.id && (
                  <pre className="mt-2 overflow-x-auto rounded-xl bg-muted/50 p-3 font-mono text-[11px] text-muted-foreground">
                    {JSON.stringify({ id: a.id, requestId: a.requestId, ip: a.ip, resourceId: a.resourceId, metadata: a.metadata }, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
