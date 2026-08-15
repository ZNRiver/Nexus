import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Cpu, MemoryStick, HardDrive, Boxes } from "lucide-react";
import { get } from "@/lib/api";
import { subscribeDashboard } from "@/lib/ws";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sparkline } from "@/components/sparkline";
import { PageHeader } from "@/components/page-header";
import { TableSkeleton } from "@/components/skeleton";
import { CustomSelect } from "@/components/ui/custom-select";
import { formatBytes, formatPercent } from "@/lib/format";
import type { MetricsPoint, Server, ServerDetail, SystemMetrics } from "@nexus/types";

export function MonitoringPage() {
  const [serverId, setServerId] = useState("");
  const [live, setLive] = useState<SystemMetrics | null>(null);
  const queryClient = useQueryClient();

  const { data: servers } = useQuery({ queryKey: ["servers"], queryFn: () => get<{ items: Server[] }>("/servers") });
  const effectiveServer = serverId || servers?.items.find((s) => s.status === "ONLINE")?.id || "";

  const { data: detail } = useQuery({
    queryKey: ["monitoring-detail", effectiveServer],
    queryFn: () => get<ServerDetail>(`/servers/${effectiveServer}`),
    enabled: !!effectiveServer,
    refetchInterval: 15000,
  });

  const { data: series } = useQuery({
    queryKey: ["monitoring-series", effectiveServer],
    queryFn: () => get<{ points: MetricsPoint[] }>(`/monitoring/servers/${effectiveServer}`, { hours: "24", bucket: "60" }),
    enabled: !!effectiveServer,
    refetchInterval: 60000,
  });

  useEffect(() => {
    const unsub = subscribeDashboard((event) => {
      if (event.type === "server.metrics" && event.serverId === effectiveServer) {
        setLive(event.metrics);
        queryClient.invalidateQueries({ queryKey: ["monitoring-detail", effectiveServer] });
      }
      if (event.type === "server.status" && event.serverId === effectiveServer) {
        queryClient.invalidateQueries({ queryKey: ["monitoring-detail", effectiveServer] });
      }
    });
    return unsub;
  }, [effectiveServer, queryClient]);

  const m = live ?? detail?.metrics ?? null;
  const points = series?.points ?? [];
  const cpu = points.map((p) => p.cpuPercent);
  const mem = points.map((p) => p.memoryPercent);
  const disk = points.map((p) => p.diskPercent);
  const containers = detail?.containers ?? [];

  return (
    <div className="p-6">
      <PageHeader
        title="Monitoring"
        description="Metrics collected by the NEXUS Agent on each server."
        actions={
          <CustomSelect
            value={effectiveServer}
            options={(servers?.items ?? []).map((s) => ({ value: s.id, label: s.name, description: s.status }))}
            onChange={(v) => setServerId(v)}
            placeholder="Select a server"
            className="w-56"
          />
        }
      />

      {!effectiveServer ? (
        <Card>
          <CardContent className="p-12 text-center text-sm text-muted-foreground">No servers connected yet.</CardContent>
        </Card>
      ) : !detail ? (
        <TableSkeleton rows={6} cols={4} />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            {[
              { label: "CPU", value: m?.cpuPercent, icon: Cpu, data: cpu, stroke: undefined },
              { label: "Memory", value: m?.memoryPercent, icon: MemoryStick, data: mem, stroke: "rgb(var(--success))" },
              { label: "Disk", value: m?.diskPercent, icon: HardDrive, data: disk, stroke: "rgb(var(--warning))" },
            ].map(({ label, value, icon: Icon, data, stroke }) => (
              <Card key={label}>
                <CardContent className="p-5">
                  <div className="flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
                    <Icon className="size-4" /> {label}
                  </div>
                  <p className="mt-1.5 text-2xl font-semibold tabular">{formatPercent(value)}</p>
                  <div className="mt-2">
                    <Sparkline data={data} width={320} height={48} stroke={stroke} />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Card>
              <CardContent className="p-4">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Containers</p>
                <p className="mt-1 text-xl font-semibold tabular">{m?.containersRunning ?? containers.length} / {m?.containersTotal ?? "—"} running</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Load (1m)</p>
                <p className="mt-1 text-xl font-semibold tabular">{m?.loadAvg1?.toFixed(2) ?? "—"}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Network</p>
                <p className="mt-1 text-sm font-semibold tabular">↓ {formatBytes(m?.networkRxBytes)} · ↑ {formatBytes(m?.networkTxBytes)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Uptime</p>
                <p className="mt-1 text-xl font-semibold tabular">{m?.uptimeSeconds ? `${Math.floor(m.uptimeSeconds / 3600)}h ${Math.floor((m.uptimeSeconds % 3600) / 60)}m` : "—"}</p>
              </CardContent>
            </Card>
          </div>

          <Card className="mt-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Boxes className="size-4 text-muted-foreground" /> Container stats
              </CardTitle>
            </CardHeader>
            <CardContent>
              {containers.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No containers on this server.</p>}
              <div className="space-y-1">
                {containers.map((c) => (
                  <div key={c.id} className="flex items-center justify-between rounded-xl px-3 py-2.5 hover:bg-foreground/[0.06]">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{c.name}</p>
                      <p className="truncate text-[11px] text-muted-foreground">{c.image}</p>
                    </div>
                    <div className="flex items-center gap-4 text-[11px] tabular text-muted-foreground">
                      <span className="flex items-center gap-1"><Cpu className="size-3" /> {formatPercent(c.cpuPercent)}</span>
                      <span className="flex items-center gap-1"><MemoryStick className="size-3" /> {formatBytes(c.memoryUsageBytes)} / {formatBytes(c.memoryLimitBytes)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <p className="mt-4 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Activity className="size-3" /> Persisted series for the last 24h in 1-minute buckets — <Link to={`/servers/${effectiveServer}`} className="text-primary hover:underline">open server command center</Link>
          </p>
        </>
      )}
    </div>
  );
}
