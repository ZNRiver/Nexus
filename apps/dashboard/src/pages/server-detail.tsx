import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, MemoryStick, HardDrive, ArrowUpDown, RefreshCw, Loader2, Trash2, Server as ServerIcon, Boxes, CloudOff } from "lucide-react";
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
import { isServerLive, serverUnavailableReason } from "@/lib/status";
import type { ServerDetail, SystemMetrics, ServerSystemInfo } from "@nexus/types";

/** Render a metric value that is only meaningful while the host is live. */
function LiveMetric({ value, suffix }: { value: string; suffix?: string }) {
  return (
    <p className="mt-1.5 text-2xl font-semibold tabular">
      {value}
      {suffix && <span className="text-base font-normal text-muted-foreground">{suffix}</span>}
    </p>
  );
}

/** Offline placeholder — never shows a stale number as if it were current. */
function UnavailableMetric() {
  return (
    <div className="mt-1.5">
      <p className="text-2xl font-semibold tabular text-muted-foreground/70">—</p>
      <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">Unavailable</p>
    </div>
  );
}

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
      <div className="p-4 sm:p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      </div>
    );
  }

  const { server, system, containers } = data;
  const live = isServerLive(server);
  // Only treat metrics as current while the host is actually connected. The API
  // persists the last heartbeat's metrics — those are history, not live data.
  const m = live ? (metrics ?? data.metrics) : null;
  const sys: ServerSystemInfo | null = system ?? null;

  return (
    <div className="p-4 sm:p-6">
      {!live && (
        <div className="mb-6 flex flex-col gap-3 rounded-2xl border border-destructive/25 bg-destructive/10 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <CloudOff className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div>
              <p className="text-sm font-semibold text-destructive">{serverUnavailableReason(server)}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Metrics, containers and system info are not being reported. Last heartbeat: {timeAgo(server.lastHeartbeatAt)}.
              </p>
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={reconnect} className="shrink-0">
            <RefreshCw className="size-3.5" /> Reconnect
          </Button>
        </div>
      )}

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

      {/* Resource cards — live values only while the host is connected */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
              <Cpu className="size-4" /> CPU
            </div>
            {live && m ? (
              <>
                <LiveMetric value={formatPercent(m.cpuPercent)} />
                <div className="mt-2">
                  <Sparkline data={series?.points.map((p) => p.cpuPercent) ?? []} height={36} className="w-full" />
                </div>
              </>
            ) : (
              <UnavailableMetric />
            )}
            <p className="mt-1 text-[11px] text-muted-foreground">
              {sys?.cpuModel ? `${sys.cpuModel} · ${sys.cpuCores} cores` : server.cpuCores ? `${server.cpuCores} cores` : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
              <MemoryStick className="size-4" /> Memory
            </div>
            {live && m ? (
              <>
                <LiveMetric value={formatPercent(m.memoryPercent)} />
                <div className="mt-2">
                  <Sparkline data={series?.points.map((p) => p.memoryPercent) ?? []} height={36} stroke="rgb(var(--success))" className="w-full" />
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {formatBytes(m.memoryUsedBytes)} / {formatBytes(m.memoryTotalBytes)}
                </p>
              </>
            ) : (
              <>
                <UnavailableMetric />
                <p className="mt-1 text-[11px] text-muted-foreground">{formatBytes(server.memoryTotalBytes)} installed</p>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
              <HardDrive className="size-4" /> Disk
            </div>
            {live && m ? (
              <>
                <LiveMetric value={formatPercent(m.diskPercent)} />
                <div className="mt-2">
                  <Sparkline data={series?.points.map((p) => p.diskPercent) ?? []} height={36} stroke="rgb(var(--warning))" className="w-full" />
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {formatBytes(m.diskUsedBytes)} / {formatBytes(m.diskTotalBytes)}
                </p>
              </>
            ) : (
              <>
                <UnavailableMetric />
                <p className="mt-1 text-[11px] text-muted-foreground">{formatBytes(server.diskTotalBytes)} total</p>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
              <ArrowUpDown className="size-4" /> Network
            </div>
            {live && m ? (
              <>
                <LiveMetric value={(m.networkRxBytes ?? 0) + (m.networkTxBytes ?? 0) > 0 ? "Active" : "Idle"} />
                <div className="mt-2 grid grid-cols-2 gap-2 text-center">
                  <div className="rounded-xl bg-muted/50 py-2">
                    <p className="text-[10px] uppercase text-muted-foreground">Down</p>
                    <p className="text-xs font-medium tabular">{formatBytes(m.networkRxBytes)}</p>
                  </div>
                  <div className="rounded-xl bg-muted/50 py-2">
                    <p className="text-[10px] uppercase text-muted-foreground">Up</p>
                    <p className="text-xs font-medium tabular">{formatBytes(m.networkTxBytes)}</p>
                  </div>
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">Load {m.loadAvg1.toFixed(2)} / {m.loadAvg5.toFixed(2)}</p>
              </>
            ) : (
              <UnavailableMetric />
            )}
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
            {live && (
              <Link to={`/containers?serverId=${server.id}`} className="text-xs text-primary hover:underline">
                View all
              </Link>
            )}
          </CardHeader>
          <CardContent className="space-y-1">
            {!live && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Containers are unavailable while the server is disconnected.
              </p>
            )}
            {live && containers.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">No containers running on this server.</p>
            )}
            {live &&
              containers.map((c) => (
                <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl px-3 py-2.5 transition-colors hover:bg-foreground/[0.06]">
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
            <div className="flex justify-between gap-2"><span className="shrink-0 text-muted-foreground">Hostname</span><span className="min-w-0 truncate font-medium">{sys?.hostname ?? server.hostname ?? "—"}</span></div>
            <div className="flex justify-between gap-2"><span className="shrink-0 text-muted-foreground">OS</span><span className="min-w-0 truncate font-medium">{sys?.os ?? server.os ?? "—"}</span></div>
            <div className="flex justify-between gap-2"><span className="shrink-0 text-muted-foreground">Architecture</span><span className="min-w-0 truncate font-medium">{sys?.arch ?? server.arch ?? "—"}</span></div>
            <div className="flex justify-between gap-2"><span className="shrink-0 text-muted-foreground">Docker</span><span className="min-w-0 truncate font-medium">{sys?.dockerVersion ?? server.dockerVersion ?? "not available"}</span></div>
            <div className="flex justify-between gap-2"><span className="shrink-0 text-muted-foreground">Kernel</span><span className="min-w-0 truncate font-medium">{sys?.kernel ?? "—"}</span></div>
            <div className="flex justify-between gap-2"><span className="shrink-0 text-muted-foreground">Uptime</span><span className="min-w-0 truncate font-medium">{live && sys?.uptimeSeconds ? `${Math.floor(sys.uptimeSeconds / 3600)}h` : "—"}</span></div>
            <div className="flex justify-between gap-2"><span className="shrink-0 text-muted-foreground">Heartbeat</span><span className="min-w-0 truncate font-medium">{timeAgo(server.lastHeartbeatAt)}</span></div>
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
                  <Button size="sm" className="h-7 shrink-0 px-2 text-[11px]" onClick={() => void saveApiUrl()} disabled={savingApiUrl}>
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
              <Link key={d.id} to={`/applications/${d.application_id}`} className="flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 hover:bg-foreground/[0.06]">
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
              <div key={a.id} className="flex items-center justify-between gap-3 rounded-xl px-3 py-2">
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
