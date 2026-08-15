import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, MemoryStick, HardDrive, ArrowUpDown, RefreshCw, Loader2, Trash2, Server as ServerIcon, Boxes } from "lucide-react";
import { get, post, patch, del } from "@/lib/api";
import { subscribeDashboard } from "@/lib/ws";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { Sparkline } from "@/components/sparkline";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/skeleton";
import { useToast } from "@/components/toast";
import { formatBytes, formatPercent, timeAgo } from "@/lib/format";
import type { ServerDetail, SystemMetrics, ServerSystemInfo } from "@nexus/types";

export function ServerDetailPage() {
  const { id = "" } = useParams();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [apiUrlEdit, setApiUrlEdit] = useState(false);
  const [apiUrlValue, setApiUrlValue] = useState("");
  const [savingApiUrl, setSavingApiUrl] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["server-detail", id],
    queryFn: () => get<ServerDetail>(`/servers/${id}`),
    refetchInterval: 10000,
  });

  const { data: series } = useQuery({
    queryKey: ["server-metrics", id],
    queryFn: () => get<{ points: { ts: string; cpuPercent: number; memoryPercent: number; diskPercent: number }[] }>(`/servers/${id}/metrics`, { hours: "6" }),
    refetchInterval: 30000,
    enabled: !!id,
  });

  // Real-time metrics from heartbeats.
  useEffect(() => {
    const unsub = subscribeDashboard((event) => {
      if (event.type === "server.metrics" && event.serverId === id) {
        setMetrics(event.metrics);
        queryClient.invalidateQueries({ queryKey: ["server-detail", id] });
      }
      if (event.type === "server.status" && event.serverId === id) {
        queryClient.invalidateQueries({ queryKey: ["server-detail", id] });
      }
    });
    return unsub;
  }, [id, queryClient]);

  const reconnect = async () => {
    try {
      await post(`/servers/${id}/reconnect`);
      toast("success", "Agent reconnected", "The agent will re-register shortly");
      queryClient.invalidateQueries({ queryKey: ["server-detail", id] });
    } catch (err) {
      toast("error", "Reconnect failed", err instanceof Error ? err.message : "Unknown error");
    }
  };

  const saveApiUrl = async () => {
    setSavingApiUrl(true);
    try {
      await patch(`/servers/${id}`, { agentApiUrl: apiUrlValue.trim() || null });
      toast("success", "Agent API URL saved", "Will apply on the next install/reconnect");
      setApiUrlEdit(false);
      queryClient.invalidateQueries({ queryKey: ["server-detail", id] });
    } catch (err) {
      toast("error", "Save failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSavingApiUrl(false);
    }
  };

  const removeServer = async () => {
    setDeleting(true);
    try {
      await del(`/servers/${id}`);
      toast("success", "Server removed", "The server was removed from NEXUS");
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      window.location.href = "/servers";
    } catch (err) {
      toast("error", "Delete failed", err instanceof Error ? err.message : "Unknown error");
      setDeleting(false);
    }
  };

  if (isLoading || !data) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-4 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      </div>
    );
  }

  const { server, system, containers } = data;
  const m = metrics ?? data.metrics;
  const sys: ServerSystemInfo | null = system ?? null;

  return (
    <div className="p-6">
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {server.name} <StatusBadge status={server.status} />
          </span>
        }
        description={`${server.host}:${server.port} · ${server.type} server · agent ${server.agentVersion ?? "not installed"}`}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={reconnect}>
              <RefreshCw className="size-4" /> Reconnect
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="size-4" /> Remove
            </Button>
          </>
        }
      />

      {/* Resource cards */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
              <Cpu className="size-4" /> CPU
            </div>
            <p className="mt-1.5 text-2xl font-semibold tabular">{formatPercent(m?.cpuPercent)}</p>
            <div className="mt-2">
              <Sparkline data={series?.points.map((p) => p.cpuPercent) ?? []} width={260} height={36} />
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">{sys?.cpuModel ? `${sys.cpuModel} · ${sys.cpuCores} cores` : `${server.cpuCores ?? "?"} cores`}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
              <MemoryStick className="size-4" /> Memory
            </div>
            <p className="mt-1.5 text-2xl font-semibold tabular">{formatPercent(m?.memoryPercent)}</p>
            <div className="mt-2">
              <Sparkline data={series?.points.map((p) => p.memoryPercent) ?? []} width={260} height={36} stroke="rgb(var(--success))" />
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {m ? `${formatBytes(m.memoryUsedBytes)} / ${formatBytes(m.memoryTotalBytes)}` : formatBytes(server.memoryTotalBytes)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
              <HardDrive className="size-4" /> Disk
            </div>
            <p className="mt-1.5 text-2xl font-semibold tabular">{formatPercent(m?.diskPercent)}</p>
            <div className="mt-2">
              <Sparkline data={series?.points.map((p) => p.diskPercent) ?? []} width={260} height={36} stroke="rgb(var(--warning))" />
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">{m ? `${formatBytes(m.diskUsedBytes)} / ${formatBytes(m.diskTotalBytes)}` : formatBytes(server.diskTotalBytes)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
              <ArrowUpDown className="size-4" /> Network
            </div>
            <p className="mt-1.5 text-2xl font-semibold tabular">{(m?.networkRxBytes ?? 0) + (m?.networkTxBytes ?? 0) > 0 ? "Active" : "—"}</p>
            <div className="mt-2 grid grid-cols-2 gap-2 text-center">
              <div className="rounded-xl bg-muted/50 py-2">
                <p className="text-[10px] uppercase text-muted-foreground">Down</p>
                <p className="text-xs font-medium tabular">{formatBytes(m?.networkRxBytes)}</p>
              </div>
              <div className="rounded-xl bg-muted/50 py-2">
                <p className="text-[10px] uppercase text-muted-foreground">Up</p>
                <p className="text-xs font-medium tabular">{formatBytes(m?.networkTxBytes)}</p>
              </div>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">Load {m ? `${m.loadAvg1.toFixed(2)} / ${m.loadAvg5.toFixed(2)}` : "—"}</p>
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {/* Containers */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Boxes className="size-4 text-muted-foreground" /> Containers
            </CardTitle>
            <Link to={`/containers?serverId=${server.id}`} className="text-xs text-primary hover:underline">
              View all
            </Link>
          </CardHeader>
          <CardContent className="space-y-1">
            {containers.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {server.status === "ONLINE" ? "No containers running on this server." : "Server is offline — containers unavailable."}
              </p>
            )}
            {containers.map((c) => (
              <div key={c.id} className="flex items-center justify-between rounded-xl px-3 py-2.5 transition-colors hover:bg-foreground/[0.06]">
                <div className="min-w-0">
                  <p className="truncate font-mono text-[13px] font-medium">{c.name}</p>
                  <p className="truncate text-[11px] text-muted-foreground">{c.image}</p>
                </div>
                <div className="flex items-center gap-3">
                  {c.cpuPercent != null && <span className="text-[11px] tabular text-muted-foreground">{c.cpuPercent.toFixed(1)}% CPU</span>}
                  <StatusBadge status={c.state === "running" ? "RUNNING" : c.state === "exited" ? "STOPPED" : c.state.toUpperCase()} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* System info */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <ServerIcon className="size-4 text-muted-foreground" /> System
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Hostname</span><span className="font-medium">{sys?.hostname ?? server.hostname ?? "—"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">OS</span><span className="font-medium">{sys?.os ?? server.os ?? "—"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Architecture</span><span className="font-medium">{sys?.arch ?? server.arch ?? "—"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Docker</span><span className="font-medium">{sys?.dockerVersion ?? server.dockerVersion ?? "not available"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Kernel</span><span className="font-medium">{sys?.kernel ?? "—"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Uptime</span><span className="font-medium">{sys?.uptimeSeconds ? `${Math.floor(sys.uptimeSeconds / 3600)}h` : "—"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Heartbeat</span><span className="font-medium">{timeAgo(server.lastHeartbeatAt)}</span></div>
            <div className="flex items-center justify-between gap-2">
              <span className="shrink-0 text-muted-foreground">Agent API URL</span>
              {apiUrlEdit ? (
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <input
                    autoFocus
                    value={apiUrlValue}
                    onChange={(e) => setApiUrlValue(e.target.value)}
                    placeholder="http://192.168.1.3:8080"
                    className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-[11px] focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring/40"
                  />
                  <Button size="sm" className="h-7 px-2 text-[11px]" onClick={() => void saveApiUrl()} disabled={savingApiUrl}>
                    {savingApiUrl ? <Loader2 className="size-3 animate-spin" /> : "Save"}
                  </Button>
                </div>
              ) : (
                <>
                  <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{server.agentApiUrl ?? "auto (detect on install)"}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 shrink-0 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      setApiUrlValue(server.agentApiUrl ?? "");
                      setApiUrlEdit(true);
                    }}
                  >
                    Edit
                  </Button>
                </>
              )}
            </div>
            {server.lastError && <p className="mt-2 rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive">{server.lastError}</p>}
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Recent Deployments</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {data.recentDeployments.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No deployments on this server yet.</p>}
            {data.recentDeployments.map((d) => (
              <Link key={d.id} to={`/applications/${d.application_id}`} className="flex items-center justify-between rounded-xl px-3 py-2.5 hover:bg-foreground/[0.06]">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{d.app_name ?? d.application_id}</p>
                  <p className="text-[11px] text-muted-foreground">{timeAgo(d.created_at)}</p>
                </div>
                <StatusBadge status={String(d.status)} />
              </Link>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Recent Activity</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {data.recentActivity.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No activity on this server yet.</p>}
            {data.recentActivity.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-xl px-3 py-2">
                <p className="truncate text-sm">{a.action.replace(/\./g, " · ")}</p>
                <span className="shrink-0 text-[11px] text-muted-foreground">{timeAgo(a.created_at)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={removeServer}
        title={`Remove ${server.name} from NEXUS`}
        description="Removing the server does not destroy remote infrastructure. To also uninstall the NEXUS Agent, use the API with ?uninstall=true."
        resourceName={server.name}
        confirmLabel="Remove server"
        loading={deleting}
      />
    </div>
  );
}
