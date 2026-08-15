import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Globe } from "lucide-react";
import { get } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { PageHeader } from "@/components/page-header";
import { TableSkeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { CustomSelect } from "@/components/ui/custom-select";
import { timeAgo } from "@/lib/format";
import type { ApplicationWithExtras, Domain } from "@nexus/types";

export function DomainsPage() {
  const [appFilter, setAppFilter] = useState("");
  const { data: apps } = useQuery({ queryKey: ["applications"], queryFn: () => get<{ items: ApplicationWithExtras[] }>("/applications", { limit: "200" }) });
  const { data: domainsByApp, isLoading } = useQuery({
    queryKey: ["all-domains"],
    queryFn: async () => {
      const map = new Map<string, Domain[]>();
      for (const app of apps?.items ?? []) {
        const res = await get<{ items: Domain[] }>(`/applications/${app.id}/domains`).catch(() => ({ items: [] }));
        if (res.items.length) map.set(app.id, res.items);
      }
      return map;
    },
    enabled: !!apps?.items.length,
  });

  const rows = useMemo(() => {
    const list: { domain: Domain; app?: ApplicationWithExtras }[] = [];
    for (const [appId, domains] of domainsByApp ?? new Map()) {
      const app = apps?.items.find((a) => a.id === appId);
      if (appFilter && appId !== appFilter) continue;
      for (const d of domains) list.push({ domain: d, app });
    }
    return list;
  }, [domainsByApp, apps, appFilter]);

  return (
    <div className="p-6">
      <PageHeader
        title="Domains"
        description="Custom hostnames attached to applications across all servers."
        actions={
          apps?.items.length ? (
            <CustomSelect
              value={appFilter}
              options={[
                { value: "", label: "All applications" },
                ...apps.items.map((a) => ({ value: a.id, label: a.name })),
              ]}
              onChange={(v) => setAppFilter(v)}
              className="w-56"
            />
          ) : undefined
        }
      />

      {isLoading ? (
        <TableSkeleton rows={6} cols={4} />
      ) : !rows.length ? (
        <EmptyState
          icon={<Globe className="size-5" />}
          title="No domains"
          description="Attach hostnames to an application from its detail page."
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="divide-y divide-border/50">
            {rows.map(({ domain, app }) => (
              <Link
                key={domain.id}
                to={app ? `/applications/${app.id}` : "/applications"}
                className="flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-foreground/[0.05]"
              >
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <Globe className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{domain.hostname}</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {app?.name ?? "unknown app"} · {domain.isPrimary ? "primary · " : ""}added {timeAgo(domain.createdAt)}
                  </p>
                </div>
                <StatusBadge status={domain.sslStatus === "DISABLED" ? "DISABLED" : domain.sslStatus} className="shrink-0" />
              </Link>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
