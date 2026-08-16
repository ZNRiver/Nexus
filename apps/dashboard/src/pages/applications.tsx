import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Boxes, Plus } from "lucide-react";
import { get } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge, HostOfflineTag } from "@/components/status-badge";
import { PageHeader } from "@/components/page-header";
import { TableSkeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { timeAgo } from "@/lib/format";
import type { ApplicationWithExtras } from "@nexus/types";

export function ApplicationsPage() {
  const { data, isLoading } = useQuery({ queryKey: ["applications"], queryFn: () => get<{ items: ApplicationWithExtras[] }>("/applications"), refetchInterval: 10000 });

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title="Applications"
        description="Web apps, APIs and workers deployed via Dockerfile or Docker Compose."
        actions={
          <Button asChild>
            <Link to="/applications/new">
              <Plus className="size-4" /> New Application
            </Link>
          </Button>
        }
      />

      {isLoading ? (
        <TableSkeleton />
      ) : !data?.items.length ? (
        <EmptyState
          icon={<Boxes className="size-5" />}
          title="No applications"
          description="Deploy your first application from a Git repository using a Dockerfile or Docker Compose."
          actionLabel="Create Application"
          actionHref="/applications/new"
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="divide-y divide-border/50">
            {data.items.map((app) => (
              <Link key={app.id} to={`/applications/${app.id}`} className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-foreground/[0.05]">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <Boxes className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-semibold">{app.name}</p>
                    <span className="hidden rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:inline">
                      {app.deploymentMethod}
                    </span>
                  </div>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {app.server?.name ?? app.serverId} · {app.repository} · {app.branch}
                  </p>
                </div>
                <div className="hidden shrink-0 text-right text-[11px] text-muted-foreground md:block">
                  <p>{app.deploymentCount} deploys</p>
                  <p>{timeAgo(app.updatedAt)}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <StatusBadge status={app.status} />
                  <HostOfflineTag status={app.server?.status} />
                </div>
              </Link>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
