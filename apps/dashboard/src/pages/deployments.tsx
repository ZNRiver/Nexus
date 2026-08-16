import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Rocket } from "lucide-react";
import { get } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { PageHeader } from "@/components/page-header";
import { TableSkeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { timeAgo, durationMs, shortId } from "@/lib/format";
import type { Deployment, ApplicationWithExtras } from "@nexus/types";

const STATUSES = ["", "QUEUED", "CLONING", "BUILDING", "PUSHING", "DEPLOYING", "STARTING", "HEALTH_CHECK", "SUCCESS", "FAILED", "CANCELLED", "WAITING_FOR_SERVER"];

export function DeploymentsPage() {
  const { data: deploys, isLoading } = useQuery({
    queryKey: ["deployments"],
    queryFn: () => get<{ items: Deployment[] }>("/deployments", { limit: "50" }),
    refetchInterval: 8000,
  });
  const { data: apps } = useQuery({ queryKey: ["applications"], queryFn: () => get<{ items: ApplicationWithExtras[] }>("/applications", { limit: "200" }) });

  const appNames = useMemo(() => new Map((apps?.items ?? []).map((a) => [a.id, a.name])), [apps]);

  return (
    <div className="p-4 sm:p-6">
      <PageHeader title="Deployments" description="Every deploy queued across all applications and servers." />

      {isLoading ? (
        <TableSkeleton rows={8} cols={5} />
      ) : !deploys?.items.length ? (
        <EmptyState
          icon={<Rocket className="size-5" />}
          title="No deployments yet"
          description="Trigger a deploy from an application page and watch the pipeline here in real time."
          actionLabel="Create Application"
          actionHref="/applications/new"
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="divide-y divide-border/50">
            {deploys.items.map((d) => (
              <Link key={d.id} to={`/applications/${d.applicationId}`} className="flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-foreground/[0.05]">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <Rocket className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{appNames.get(d.applicationId) ?? d.applicationId}</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {d.branch} {d.commit ? `· ${shortId(d.commit)}` : ""} · {d.image ?? "no image"} · {timeAgo(d.createdAt)}
                  </p>
                </div>
                <div className="hidden shrink-0 text-right text-[11px] text-muted-foreground sm:block">
                  <p>{durationMs(d.durationMs)}</p>
                  <p>{d.triggeredByName ?? "system"}</p>
                </div>
                <StatusBadge status={d.status} className="shrink-0" />
              </Link>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
