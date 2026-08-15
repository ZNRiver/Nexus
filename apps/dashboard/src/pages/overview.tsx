import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Database, Gamepad2, Rocket, Server, Container, Activity, TrendingUp, XCircle, CircleAlert, ArrowUpRight } from "lucide-react";
import { get } from "@/lib/api";
import { subscribeDashboard } from "@/lib/ws";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge, StatusPill } from "@/components/status-badge";
import { Sparkline } from "@/components/sparkline";
import { CardSkeleton } from "@/components/skeleton";
import { PageHeader } from "@/components/page-header";
import { timeAgo, formatPercent } from "@/lib/format";
import type { DashboardOverview } from "@nexus/types";

function StatCard({ label, value, sub, icon: Icon, href }: { label: string; value: string | number; sub?: string; icon: React.ElementType; href?: string }) {
  const inner = (
    <Card className="group card-hover transition-all duration-200">
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
            <p className="mt-2 text-3xl font-bold tabular tracking-tight text-foreground">{value}</p>
            {sub && <p className="mt-1 text-[11px] text-muted-foreground/80">{sub}</p>}
          </div>
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
            <Icon className="size-5" strokeWidth={1.8} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
  return href ? <Link to={href} className="transition-transform hover:scale-[1.01] active:scale-[0.99]">{inner}</Link> : inner;
}

export function OverviewPage() {
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["overview"],
    queryFn: () => get<DashboardOverview>("/overview"),
    refetchInterval: 15000,
  });

  // Real-time updates — invalidate on WS events.
  useEffect(() => {
    const unsub = subscribeDashboard((event) => {
      if (["server.status", "server.metrics", "deployment.status", "deployment.log", "notification", "database.status", "game.status"].includes(event.type)) {
        queryClient.invalidateQueries({ queryKey: ["overview"] });
      }
    });
    return unsub;
  }, [queryClient]);

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <CardSkeleton key={i} rows={2} />
          ))}
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="flex flex-col items-center p-12 text-center">
            <CircleAlert className="size-8 text-destructive" />
            <h2 className="mt-3 text-sm font-semibold">Could not load the dashboard</h2>
            <p className="mt-1 text-sm text-muted-foreground">Make sure the NEXUS API is reachable.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6">
      <PageHeader title="Overview" description="Your infrastructure at a glance." />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Servers" value={data.servers.total} sub={`${data.servers.online} online`} icon={Server} href="/servers" />
        <StatCard label="Applications" value={data.applications.total} sub={`${data.applications.running} running`} icon={Boxes} href="/applications" />
        <StatCard label="Databases" value={data.databases.total} sub={`${data.databases.running} running`} icon={Database} href="/databases" />
        <StatCard label="Game Servers" value={data.gameServers.total} sub={`${data.gameServers.running} running`} icon={Gamepad2} href="/game-servers" />
        <StatCard label="Containers" value={data.containers.total} sub={`${data.containers.running} running`} icon={Container} href="/containers" />
        <StatCard label="Deployments" value={data.deployments.total} sub={`${data.deployments.failed} failed`} icon={Rocket} href="/deployments" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {/* Server health */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Activity className="size-4 text-muted-foreground" /> Server Health
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {data.serverHealth.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No servers yet</p>}
            {data.serverHealth.map((s) => (
              <Link key={s.serverId} to={`/servers/${s.serverId}`} className="flex items-center justify-between rounded-xl px-3 py-2.5 transition-colors hover:bg-foreground/[0.06]">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{s.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    CPU {formatPercent(s.cpuPercent)} · Mem {formatPercent(s.memoryPercent)} · Disk {formatPercent(s.diskPercent)}
                  </p>
                </div>
                <StatusBadge status={s.status} />
              </Link>
            ))}
          </CardContent>
        </Card>

        {/* Resource usage */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <TrendingUp className="size-4 text-muted-foreground" /> Resource Usage <span className="text-xs font-normal text-muted-foreground">(last 6h)</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.resourceUsage.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">No online servers with metrics yet</p>}
            <div className="space-y-4">
              {data.resourceUsage.map((r) => (
                <div key={r.serverId} className="flex items-center gap-4">
                  <span className="w-28 shrink-0 truncate text-xs font-medium text-muted-foreground">{r.name}</span>
                  <Sparkline data={r.metrics.map((m) => m.cpuPercent)} width={200} height={32} className="shrink-0" />
                  <Sparkline data={r.metrics.map((m) => m.memoryPercent)} width={120} height={32} stroke="rgb(var(--success))" className="shrink-0" />
                  <span className="ml-auto shrink-0 text-right text-[11px] tabular text-muted-foreground">
                    <span className="text-foreground">CPU {formatPercent(r.metrics.at(-1)?.cpuPercent)}</span>
                    <br />
                    <span className="text-success">Mem {formatPercent(r.metrics.at(-1)?.memoryPercent)}</span>
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* Recent deployments */}
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Rocket className="size-4 text-muted-foreground" /> Recent Deployments
            </CardTitle>
            <Link to="/deployments" className="flex items-center gap-1 text-xs text-primary hover:underline">
              All <ArrowUpRight className="size-3" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-1">
            {data.recentDeployments.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">No deployments yet — deploy an application to see progress here.</p>}
            {data.recentDeployments.map((d) => (
              <Link key={d.id} to={`/applications/${d.applicationId}`} className="flex items-center justify-between rounded-xl px-3 py-2.5 transition-colors hover:bg-foreground/[0.06]">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{d.appName ?? d.applicationId}</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {d.branch} {d.commit ? `· ${d.commit}` : ""} · {timeAgo(d.createdAt)}
                  </p>
                </div>
                <StatusBadge status={d.status} />
              </Link>
            ))}
          </CardContent>
        </Card>

        {/* Recent activity */}
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-sm">
              <XCircle className="size-4 text-muted-foreground" /> Recent Activity
            </CardTitle>
            <Link to="/audit" className="flex items-center gap-1 text-xs text-primary hover:underline">
              Audit log <ArrowUpRight className="size-3" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-1">
            {data.recentActivity.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">No activity recorded yet.</p>}
            {data.recentActivity.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-xl px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{a.action.replace(/\./g, " · ")}</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {a.userName ?? "system"} {a.resourceName ? `· ${a.resourceName}` : ""}
                  </p>
                </div>
                <span className="shrink-0 text-[11px] text-muted-foreground">{timeAgo(a.createdAt)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {data.pendingJobs > 0 && (
        <div className="mt-4">
          <StatusPill status="PENDING" /> <span className="text-xs text-muted-foreground">{data.pendingJobs} job(s) queued</span>
        </div>
      )}
    </div>
  );
}
