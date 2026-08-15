import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Terminal, Play, Square, RotateCw, ExternalLink, Globe, FolderTree, Database as DatabaseIcon,
  CalendarClock, Users, Archive, Network as NetworkIcon, Rocket, Settings as SettingsIcon,
  Activity as ActivityIcon, Loader2, Trash2, Radio, Timer, Cpu, MemoryStick, HardDrive,
  ArrowDownToLine, ArrowUpFromLine,
} from "lucide-react";
import { get, post, del } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, type TabDef } from "@/components/ui/Tabs";
import { StatusBadge } from "@/components/status-badge";
import { Sparkline } from "@/components/sparkline";
import { Skeleton } from "@/components/skeleton";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useToast } from "@/components/toast";
import { formatBytes, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { GameServer, Server, SystemMetrics } from "@nexus/types";

type TabKey = "console" | "files" | "databases" | "schedules" | "users" | "backups" | "network" | "startup" | "settings" | "activity";

const TABS: TabDef<TabKey>[] = [
  { key: "console", label: "Console", icon: Terminal },
  { key: "files", label: "Files", icon: FolderTree },
  { key: "databases", label: "Databases", icon: DatabaseIcon },
  { key: "schedules", label: "Schedules", icon: CalendarClock },
  { key: "users", label: "Users", icon: Users },
  { key: "backups", label: "Backups", icon: Archive },
  { key: "network", label: "Network", icon: NetworkIcon },
  { key: "startup", label: "Startup", icon: Rocket },
  { key: "settings", label: "Settings", icon: SettingsIcon },
  { key: "activity", label: "Activity", icon: ActivityIcon },
];

interface LogLine {
  ts: string;
  level: "INFO" | "WARN" | "ERROR" | "SYSTEM";
  text: string;
}

/** Parse raw container log lines into { timestamp, level, text }. */
function parseLogs(raw: string): LogLine[] {
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  return lines.map((line) => {
    const tsMatch = line.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?)\s*\]?/);
    const ts = tsMatch?.[1] ?? "";
    const upper = line.toUpperCase();
    let level: LogLine["level"] = "INFO";
    if (/\b(WARN|WARNING)\b/.test(upper)) level = "WARN";
    else if (/\b(ERROR|FATAL|EXCEPTION|SEVERE)\b/.test(upper)) level = "ERROR";
    return { ts, level, text: line };
  });
}

const levelClass: Record<LogLine["level"], string> = {
  INFO: "text-zinc-100",
  WARN: "text-amber-300",
  ERROR: "text-red-400",
  SYSTEM: "text-sky-300",
};

function fmtUptime(startIso: string | null): string {
  if (!startIso) return "—";
  const ms = Date.now() - new Date(startIso).getTime();
  if (ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

export function GameServerDetailPage() {
  const { id = "" } = useParams();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TabKey>("console");
  const [cmd, setCmd] = useState("");
  const [execBusy, setExecBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [destroy, setDestroy] = useState(false);
  const consoleRef = useRef<HTMLDivElement>(null);

  // History buffers for the charts (last 60 samples, ~5s apart).
  const [cpuHist, setCpuHist] = useState<number[]>([]);
  const [memHist, setMemHist] = useState<number[]>([]);
  const [rxHist, setRxHist] = useState<number[]>([]);
  const [txHist, setTxHist] = useState<number[]>([]);
  const [lastNet, setLastNet] = useState<{ rx: number; tx: number } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["game-server-detail", id],
    queryFn: () =>
      get<{ gameServer: GameServer; server: Server | null; system: SystemMetrics | null }>(`/game-servers/${id}`),
    refetchInterval: 15000,
  });

  const game = data?.gameServer;
  const server = data?.server;
  const system = data?.system;

  const { data: stats } = useQuery({
    queryKey: ["game-server-stats", id],
    queryFn: () =>
      get<{ cpuPercent: number; memoryUsageBytes: number; memoryLimitBytes: number; networkRxBytes: number; networkTxBytes: number }>(
        `/game-servers/${id}/stats`,
      ),
    enabled: !!game?.containerId,
    refetchInterval: 5000,
  });

  // Feed the charts from each stats poll.
  useEffect(() => {
    if (!stats) return;
    setCpuHist((h) => [...h.slice(-59), stats.cpuPercent]);
    setMemHist((h) => [...h.slice(-59), stats.memoryUsageBytes / 1024 / 1024]);
    if (lastNet && (stats.networkRxBytes >= lastNet.rx || stats.networkTxBytes >= lastNet.tx)) {
      setRxHist((h) => [...h.slice(-59), Math.max(0, stats.networkRxBytes - lastNet.rx)]);
      setTxHist((h) => [...h.slice(-59), Math.max(0, stats.networkTxBytes - lastNet.tx)]);
    }
    setLastNet({ rx: stats.networkRxBytes, tx: stats.networkTxBytes });
  }, [stats, lastNet]);

  const { data: logsData, refetch: refetchLogs } = useQuery({
    queryKey: ["game-server-logs", id],
    queryFn: () => get<{ logs: string }>(`/game-servers/${id}/logs?tail=200`),
    enabled: !!game?.containerId && tab === "console",
    refetchInterval: tab === "console" && game?.containerId ? 5000 : false,
  });

  const logs = useMemo(() => parseLogs(logsData?.logs ?? ""), [logsData]);

  useEffect(() => {
    if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [logs.length]);

  const runAction = async (action: "start" | "stop" | "restart") => {
    setActionBusy(true);
    try {
      await post(`/game-servers/${id}/${action}`);
      toast("success", `${action[0].toUpperCase()}${action.slice(1)} requested`, game?.name);
      queryClient.invalidateQueries({ queryKey: ["game-server-detail", id] });
      queryClient.invalidateQueries({ queryKey: ["game-server-logs", id] });
      setTimeout(() => refetchLogs(), 800);
    } catch (err) {
      toast("error", "Action failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setActionBusy(false);
    }
  };

  const runExec = async () => {
    const parts = cmd.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0 || !game?.containerId) return;
    setExecBusy(true);
    try {
      const res = await post<{ output: string; exitCode: number }>(`/game-servers/${id}/exec`, { cmd: parts });
      if (res.output?.trim()) {
        toast("success", "Command sent", parts.join(" "));
      } else {
        toast("success", "Command sent", `${parts.join(" ")} (exit ${res.exitCode})`);
      }
      setTimeout(() => refetchLogs(), 600);
    } catch (err) {
      toast("error", "Command failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setExecBusy(false);
      setCmd("");
    }
  };

  const removeGame = async () => {
    setDeleting(true);
    try {
      await del(`/game-servers/${id}${destroy ? "?destroy=true" : ""}`);
      toast("success", "Game server deleted", game?.name);
      window.location.href = "/game-servers";
    } catch (err) {
      toast("error", "Delete failed", err instanceof Error ? err.message : "Unknown error");
      setDeleting(false);
    }
  };

  const address = server ? `${server.host}:${game?.port ?? "25565"}` : "—";
  const uptimeStart = game?.status === "RUNNING" ? game.updatedAt : null;
  const memLimit = stats?.memoryLimitBytes ?? game?.memoryBytes ?? 0;
  const memUsed = stats?.memoryUsageBytes ?? 0;
  const diskLimit = game?.storageBytes ?? 0;
  const diskUsed = system?.diskUsedBytes ?? null;
  const diskTotal = system?.diskTotalBytes ?? diskLimit;

  if (isLoading || !data || !game) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-10" />
        <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }

  const running = game.status === "RUNNING";

  return (
    <div className="p-6">
      {/* Tabs bar */}
      <div className="flex items-center justify-between gap-3">
        <Tabs tabs={TABS} value={tab} onChange={setTab} className="flex-1" />
        <a
          href={`http://${address}`}
          target="_blank"
          rel="noreferrer"
          title={`Open ${address}`}
          className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-input bg-card text-muted-foreground transition-colors hover:border-ring/40 hover:text-foreground"
        >
          <ExternalLink className="size-4" />
        </a>
      </div>

      {/* Title */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <GamepadIcon />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <h1 className="truncate text-2xl font-semibold tracking-tight">{game.name}</h1>
              <StatusBadge status={game.status} />
            </div>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              {game.flavor ?? "Minecraft"} {game.version} · {server?.name ?? game.serverId} · updated {timeAgo(game.updatedAt)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => runAction("start")} disabled={actionBusy || running || !game.containerId}>
            {actionBusy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} Start
          </Button>
          <Button variant="outline" onClick={() => runAction("restart")} disabled={actionBusy || !running}>
            <RotateCw className="size-4" /> Restart
          </Button>
          <Button variant="destructive" onClick={() => runAction("stop")} disabled={actionBusy || !running}>
            <Square className="size-4" /> Stop
          </Button>
        </div>
      </div>

      <div className="mt-6">
        {tab === "console" && (
          <div className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
              {/* Console terminal */}
              <Card className="overflow-hidden">
                <CardHeader className="flex-row items-center justify-between border-b border-border/50 bg-muted/30 py-2.5">
                  <CardTitle className="flex items-center gap-2 text-[13px] font-medium">
                    <Terminal className="size-3.5 text-muted-foreground" /> Console
                  </CardTitle>
                  <span className="text-[11px] text-muted-foreground">{running ? "live · 5s" : "stopped"}</span>
                </CardHeader>
                <CardContent className="p-0">
                  <div ref={consoleRef} className="h-[420px] overflow-auto bg-black/85 p-4 font-mono text-[11.5px] leading-relaxed">
                    {logs.length === 0 && (
                      <p className="py-8 text-center text-sm text-zinc-500">
                        {game.containerId ? "No console output yet — send a command or wait for the server to boot." : "Container not running — start the server to see its console."}
                      </p>
                    )}
                    {logs.map((l, i) => (
                      <div key={i} className="flex gap-3 whitespace-pre-wrap break-all">
                        <span className="shrink-0 select-none text-zinc-500">{l.ts || "••••••"}</span>
                        <span className={levelClass[l.level]}>{l.text}</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-2 border-t border-border/50 bg-muted/30 px-3 py-2.5">
                    <span className="select-none font-mono text-sm font-semibold text-primary">&gt;&gt;</span>
                    <input
                      value={cmd}
                      onChange={(e) => setCmd(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && runExec()}
                      placeholder="Type a command..."
                      disabled={!running || execBusy}
                      className="h-9 flex-1 bg-transparent font-mono text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none disabled:opacity-50"
                    />
                    <Button size="sm" onClick={runExec} disabled={!running || execBusy || !cmd.trim()}>
                      {execBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Terminal className="size-3.5" />} Send
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Sidebar: actions + live metrics */}
              <div className="space-y-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-[13px] font-medium">Server Status</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex gap-2">
                      <Button size="sm" className="flex-1" onClick={() => runAction("start")} disabled={actionBusy || running || !game.containerId}>
                        {actionBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} Start
                      </Button>
                      <Button size="sm" variant="outline" className="flex-1" onClick={() => runAction("restart")} disabled={actionBusy || !running}>
                        <RotateCw className="size-3.5" /> Restart
                      </Button>
                      <Button size="sm" variant="destructive" className="flex-1" onClick={() => runAction("stop")} disabled={actionBusy || !running}>
                        <Square className="size-3.5" /> Stop
                      </Button>
                    </div>
                    <Button size="sm" variant="outline" className="w-full" onClick={() => setDeleteOpen(true)}>
                      <Trash2 className="size-3.5" /> Delete server
                    </Button>
                  </CardContent>
                </Card>

                <MetricCard icon={<Radio className="size-3.5" />} label="Address" value={address} mono />
                <MetricCard icon={<Timer className="size-3.5" />} label="Uptime" value={running ? fmtUptime(uptimeStart) : "—"} />
                <MetricCard
                  icon={<Cpu className="size-3.5" />}
                  label="CPU Load"
                  value={`${stats?.cpuPercent?.toFixed(2) ?? "0.00"}% / ${game.cpuLimit ? `${game.cpuLimit} cores` : "∞"}`}
                />
                <MetricCard
                  icon={<MemoryStick className="size-3.5" />}
                  label="Memory"
                  value={`${formatBytes(memUsed || null)} / ${formatBytes(memLimit || null)}`}
                />
                <MetricCard
                  icon={<HardDrive className="size-3.5" />}
                  label="Disk"
                  value={`${formatBytes(diskUsed)} / ${formatBytes(diskTotal)}`}
                />
                <MetricCard
                  icon={<ArrowDownToLine className="size-3.5" />}
                  label="Network (Inbound)"
                  value={stats?.networkRxBytes ? formatBytes(stats.networkRxBytes) : "0 B"}
                />
                <MetricCard
                  icon={<ArrowUpFromLine className="size-3.5" />}
                  label="Network (Outbound)"
                  value={stats?.networkTxBytes ? formatBytes(stats.networkTxBytes) : "0 B"}
                />
              </div>
            </div>

            {/* Charts */}
            <div className="grid gap-4 md:grid-cols-3">
              <ChartCard
                title="CPU Load"
                unit="%"
                value={stats ? `${stats.cpuPercent.toFixed(2)}%` : "—"}
                lowLabel="0%"
                highLabel={`${game.cpuLimit ? game.cpuLimit * 100 : 100}%`}
                data={cpuHist}
                stroke="rgb(var(--primary))"
              />
              <ChartCard
                title="Memory"
                unit="MiB"
                value={stats ? `${Math.round(memUsed / 1024 / 1024)}MiB` : "—"}
                lowLabel="0MiB"
                highLabel={`${Math.round(memLimit / 1024 / 1024)}MiB`}
                data={memHist}
                stroke="rgb(56 189 248)"
              />
              <ChartCard
                title="Network"
                unit="Bytes"
                value={stats ? formatBytes((stats.networkRxBytes ?? 0) + (stats.networkTxBytes ?? 0)) : "—"}
                lowLabel="0B"
                highLabel="peak"
                data={rxHist.map((v, i) => v + (txHist[i] ?? 0))}
                stroke="rgb(74 222 128)"
              />
            </div>
          </div>
        )}

        {tab !== "console" && (
          <Card>
            <CardContent className="py-16 text-center">
              <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                {TABS.find((t) => t.key === tab)?.icon ? <TabsIcon tab={tab} /> : <Globe className="size-5" />}
              </div>
              <h3 className="mt-4 text-sm font-semibold">{TABS.find((t) => t.key === tab)?.label}</h3>
              <p className="mx-auto mt-1 max-w-sm text-[13px] text-muted-foreground">
                {tab === "startup"
                  ? "Startup variables and Docker image configuration — managed at creation time."
                  : tab === "settings"
                    ? "Server limits, port and container settings are managed at creation time."
                    : tab === "network"
                      ? "Allocation details are visible in the Console overview. Port forwarding requires a proxy provider."
                      : `${TABS.find((t) => t.key === tab)?.label} management is coming soon.`}
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={removeGame}
        loading={deleting}
        title="Delete game server"
        description="The container will be removed from the server. The persistent volume is kept unless you choose to destroy it."
        resourceName={game.name}
        confirmLabel="Delete server"
        extra={
          <label className="flex cursor-pointer items-center gap-2 text-[13px]">
            <input type="checkbox" checked={destroy} onChange={(e) => setDestroy(e.target.checked)} className="accent-primary" />
            Also destroy persistent data
          </label>
        }
      />
    </div>
  );
}

function GamepadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-5">
      <line x1="6" x2="10" y1="11" y2="11" />
      <line x1="8" x2="8" y1="9" y2="13" />
      <line x1="15" x2="15.01" y1="12" y2="12" />
      <line x1="18" x2="18.01" y1="10" y2="10" />
      <path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z" />
    </svg>
  );
}

function TabsIcon({ tab }: { tab: TabKey }) {
  const Icon = TABS.find((t) => t.key === tab)?.icon ?? Globe;
  return <Icon className="size-5" />;
}

function MetricCard({ icon, label, value, mono = false }: { icon: React.ReactNode; label: string; value: string; mono?: boolean }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 px-4 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">{icon}</span>
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className={cn("truncate text-[13px] font-medium tabular", mono && "font-mono")}>{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function ChartCard({
  title, unit, value, lowLabel, highLabel, data, stroke,
}: {
  title: string; unit: string; value: string; lowLabel: string; highLabel: string; data: number[]; stroke: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-[13px] font-medium">
          <span>{title}</span>
          <span className="font-mono text-xs tabular text-muted-foreground">{value}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-3">
        <Sparkline data={data.length >= 2 ? data : [0, 0]} width={300} height={72} stroke={stroke} className="w-full" />
        <div className="mt-2 flex justify-between text-[10px] text-muted-foreground/70">
          <span>{lowLabel}</span>
          <span>{highLabel}</span>
        </div>
      </CardContent>
    </Card>
  );
}
