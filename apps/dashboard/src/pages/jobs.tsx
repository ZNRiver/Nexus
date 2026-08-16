import { useQuery } from "@tanstack/react-query";
import { ListTodo } from "lucide-react";
import { get } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { PageHeader } from "@/components/page-header";
import { TableSkeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { timeAgo, durationMs } from "@/lib/format";
import type { Job } from "@nexus/types";

export function JobsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["jobs"],
    queryFn: () => get<{ items: Job[] }>("/jobs", { limit: "50" }),
    refetchInterval: 5000,
  });

  return (
    <div className="p-4 sm:p-6">
      <PageHeader title="Jobs" description="Background workers executing deployments, backups and infrastructure operations." />

      {isLoading ? (
        <TableSkeleton rows={8} cols={5} />
      ) : !data?.items.length ? (
        <EmptyState icon={<ListTodo className="size-5" />} title="No jobs" description="Queued background work will appear here." />
      ) : (
        <Card className="overflow-hidden">
          <div className="divide-y divide-border/50">
            {data.items.map((j) => (
              <div key={j.id} className="flex items-center gap-4 px-5 py-3.5">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <ListTodo className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{j.type}</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {j.id} · attempt {j.attempts}/{j.maxAttempts} · {timeAgo(j.createdAt)}
                  </p>
                  {j.error && <p className="mt-0.5 truncate text-[11px] text-destructive">{j.error}</p>}
                </div>
                <div className="hidden shrink-0 text-right text-[11px] text-muted-foreground sm:block">
                  <p>{durationMs(j.finishedAt ? new Date(j.finishedAt).getTime() - new Date(j.createdAt).getTime() : null)}</p>
                </div>
                <StatusBadge status={j.status} className="shrink-0" />
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
