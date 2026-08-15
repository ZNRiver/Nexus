import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Terminal, Play, Square, RotateCw, ExternalLink, Globe, FolderTree,
  CalendarClock, Users, Archive, Network as NetworkIcon, Rocket, Settings as SettingsIcon,
  Activity as ActivityIcon, Loader2, Trash2, Radio, Timer, Cpu, MemoryStick, HardDrive,
  ArrowDownToLine, ArrowUpFromLine, FolderPlus, FilePlus, Upload, FileText, MoreHorizontal,
  Download, Lock, Unlock, Pencil, Save, ChevronRight, Plus, X, RefreshCw, PlayCircle, Folder, File,
  Star, TerminalSquare, Check,
} from "lucide-react";
import { get, post, patch, put, del, downloadBackup } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, type TabDef } from "@/components/ui/Tabs";
import { StatusBadge } from "@/components/status-badge";
import { Sparkline } from "@/components/sparkline";
import { Skeleton } from "@/components/skeleton";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/toast";
import { formatBytes, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { GameServer, Server, SystemMetrics } from "@nexus/types";

type TabKey = "console" | "files" | "schedules" | "users" | "backups" | "network" | "startup" | "settings" | "activity";

const TABS: TabDef<TabKey>[] = [
  { key: "console", label: "Console", icon: Terminal },
  { key: "files", label: "Files", icon: FolderTree },
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
  const lastNetRef = useRef<{ rx: number; tx: number } | null>(null);
  const lastStatsRef = useRef<{ cpuPercent: number; memoryUsageBytes: number; memoryLimitBytes: number; networkRxBytes: number; networkTxBytes: number } | null>(null);

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

  // Feed the charts from each stats poll. Guard with refs so a new stats object
  // (or our own lastNet update) can't retrigger this effect in a loop.
  useEffect(() => {
    if (!stats || lastStatsRef.current === stats) return;
    lastStatsRef.current = stats;
    setCpuHist((h) => [...h.slice(-59), stats.cpuPercent]);
    setMemHist((h) => [...h.slice(-59), stats.memoryUsageBytes / 1024 / 1024]);
    const lastNet = lastNetRef.current;
    if (lastNet && (stats.networkRxBytes >= lastNet.rx || stats.networkTxBytes >= lastNet.tx)) {
      setRxHist((h) => [...h.slice(-59), Math.max(0, stats.networkRxBytes - lastNet.rx)]);
      setTxHist((h) => [...h.slice(-59), Math.max(0, stats.networkTxBytes - lastNet.tx)]);
    }
    lastNetRef.current = { rx: stats.networkRxBytes, tx: stats.networkTxBytes };
  }, [stats]);

  const { data: logsData, refetch: refetchLogs } = useQuery({
    queryKey: ["game-server-logs", id],
    queryFn: () => get<{ logs: string }>(`/game-servers/${id}/logs?tail=200`),
    enabled: !!game?.containerId && tab === "console",
    refetchInterval: tab === "console" && game?.containerId ? 5000 : false,
  });

  const logs = useMemo(() => parseLogs(logsData?.logs ?? ""), [logsData]);

  // Always jump to the newest logs (bottom) when the Console tab opens, and
  // follow new lines as they arrive. Deps include `tab` so re-entering the tab
  // (cached logs, same length) still scrolls down instead of staying at the top.
  useEffect(() => {
    if (tab !== "console") return;
    if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [tab, logs.length]);

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

        {tab === "files" && <FilesTab game={game} />}
        {tab === "schedules" && <SchedulesTab game={game} />}
        {tab === "backups" && <BackupsTab game={game} />}
        {tab === "network" && <NetworkTab game={game} />}
        {tab === "startup" && <StartupTab game={game} />}
        {tab === "users" && (
          <Card>
            <CardContent className="py-16 text-center">
              <Users className="mx-auto size-10 text-muted-foreground/50" />
              <h3 className="mt-4 text-sm font-semibold">Users</h3>
              <p className="mx-auto mt-1 max-w-sm text-[13px] text-muted-foreground">
                Sub-user management for game servers is not available yet.
              </p>
            </CardContent>
          </Card>
        )}
        {tab === "settings" && <SettingsTab game={game} />}
        {tab === "activity" && <ActivityTab game={game} />}
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

/* ─────────────────────────────────────────────────────────────────
   Files — Pterodactyl-style file manager
   ───────────────────────────────────────────────────────────────── */

const DATA_ROOT = "/data";

interface GameFileEntry {
  name: string;
  type: "dir" | "file";
  size: number;
  mtime: number;
}

const displayPath = (p: string): string => (p === DATA_ROOT ? "/home/container/" : `/home/container${p.slice(DATA_ROOT.length)}`);
const joinPath = (base: string, name: string): string => `${base === DATA_ROOT ? "" : base}/${name}`;

function FilesTab({ game }: { game: GameServer }) {
  const { toast } = useToast();
  const [path, setPath] = useState(DATA_ROOT);
  const [entries, setEntries] = useState<GameFileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<{ path: string; name: string; content: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [mkModal, setMkModal] = useState<null | "dir" | "file">(null);
  const [mkName, setMkName] = useState("");
  const [mkBusy, setMkBusy] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ path: string; name: string } | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ path: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = async (p: string) => {
    setLoading(true);
    setErr(null);
    try {
      const res = await get<{ path: string; entries: GameFileEntry[] }>(`/game-servers/${game.id}/files?path=${encodeURIComponent(p)}`);
      setEntries(res.entries);
      setSel(new Set());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to list files");
      setEntries(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, game.id]);

  const crumbs = (() => {
    const parts = path === DATA_ROOT ? [] : path.slice(DATA_ROOT.length).split("/").filter(Boolean);
    const acc = [DATA_ROOT];
    const out: { label: string; path: string }[] = [{ label: "home", path: DATA_ROOT }];
    for (const p of parts) {
      const next = joinPath(acc[acc.length - 1], p);
      acc.push(next);
      out.push({ label: p, path: next });
    }
    return out;
  })();

  const openEditor = async (name: string) => {
    const full = joinPath(path, name);
    try {
      const res = await get<{ path: string; content: string; bytes: number }>(`/game-servers/${game.id}/files/content?path=${encodeURIComponent(full)}`);
      setEditor({ path: full, name, content: res.content });
    } catch (e) {
      toast("error", "Failed to open file", e instanceof Error ? e.message : "Unknown error");
    }
  };

  const saveFile = async () => {
    if (!editor) return;
    setSaving(true);
    try {
      const res = await post<{ path: string; bytes: number }>(`/game-servers/${game.id}/files/write`, { path: editor.path, content: editor.content });
      toast("success", "File saved", `${editor.name} (${res.bytes} bytes)`);
      setEditor(null);
      void load(path);
    } catch (e) {
      toast("error", "Save failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  };

  const submitMk = async () => {
    if (!mkModal || !mkName.trim()) return;
    setMkBusy(true);
    const full = joinPath(path, mkName.trim());
    try {
      if (mkModal === "dir") {
        await post(`/game-servers/${game.id}/files/mkdir`, { path: full });
      } else {
        await post(`/game-servers/${game.id}/files/write`, { path: full, content: "" });
      }
      toast("success", mkModal === "dir" ? "Directory created" : "File created", mkName.trim());
      setMkModal(null);
      setMkName("");
      void load(path);
    } catch (e) {
      toast("error", "Failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setMkBusy(false);
    }
  };

  const submitRename = async () => {
    if (!renameTarget || !renameTo.trim()) return;
    setRenameBusy(true);
    try {
      const res = await post<{ from: string; to: string }>(`/game-servers/${game.id}/files/rename`, { path: renameTarget.path, newName: renameTo.trim() });
      toast("success", "Renamed", res.to);
      setRenameTarget(null);
      void load(path);
    } catch (e) {
      toast("error", "Rename failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setRenameBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await post(`/game-servers/${game.id}/files/delete`, { path: deleteTarget.path, recursive: true });
      toast("success", "Deleted", deleteTarget.name);
      setDeleteTarget(null);
      void load(path);
    } catch (e) {
      toast("error", "Delete failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setDeleting(false);
    }
  };

  const downloadFile = async (name: string) => {
    try {
      const full = joinPath(path, name);
      const res = await get<{ path: string; content: string; bytes: number }>(`/game-servers/${game.id}/files/content?path=${encodeURIComponent(full)}`);
      const blob = new Blob([res.content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast("error", "Download failed", e instanceof Error ? e.message : "Unknown error");
    }
  };

  const onUpload = async (file: File) => {
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      toast("error", "File too large", "Uploads through the panel are capped at 4 MB (text files).");
      return;
    }
    try {
      const content = await file.text();
      const full = joinPath(path, file.name);
      await post(`/game-servers/${game.id}/files/write`, { path: full, content });
      toast("success", "Uploaded", file.name);
      void load(path);
    } catch (e) {
      toast("error", "Upload failed", e instanceof Error ? e.message : "Unknown error");
    }
  };

  return (
    <div className="space-y-4">
      {/* Path bar + actions */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto font-mono text-[13px] scrollbar-hide">
            {crumbs.map((c, i) => (
              <span key={c.path} className="flex shrink-0 items-center">
                {i > 0 && <ChevronRight className="size-3.5 text-muted-foreground/50" />}
                <button
                  onClick={() => setPath(c.path)}
                  className={cn("rounded px-1.5 py-0.5 transition-colors", i === crumbs.length - 1 ? "text-primary" : "text-muted-foreground hover:text-foreground")}
                >
                  {c.label}
                </button>
              </span>
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="sm" variant="outline" onClick={() => { setMkModal("dir"); setMkName(""); }}>
              <FolderPlus className="size-3.5" /> Create Directory
            </Button>
            <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}>
              <Upload className="size-3.5" /> Upload
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setMkModal("file"); setMkName(""); }}>
              <FilePlus className="size-3.5" /> New File
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onUpload(f);
                e.target.value = "";
              }}
            />
            <Button size="sm" variant="ghost" onClick={() => void load(path)} disabled={loading} title="Refresh">
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            </Button>
          </div>
        </CardContent>
      </Card>

      {sel.size > 0 && (
        <div className="flex items-center justify-between rounded-xl border border-border/60 bg-muted/40 px-3 py-2">
          <span className="text-[12.5px] text-muted-foreground">{sel.size} selected</span>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              const first = entries?.find((e) => sel.has(e.name));
              if (first) setDeleteTarget({ path: joinPath(path, first.name), name: `${sel.size} item(s)` });
            }}
          >
            <Trash2 className="size-3.5" /> Delete selected
          </Button>
        </div>
      )}

      {/* File table */}
      <Card>
        <CardContent className="p-0">
          {err && <p className="px-4 py-8 text-center text-sm text-destructive">{err}</p>}
          {loading && entries === null && <Skeleton className="h-64 rounded-none" />}
          {!err && !loading && entries !== null && (
            <div className="overflow-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead className="bg-muted/60 text-left">
                  <tr>
                    <th className="w-10 border-b border-border/60 px-3 py-2">
                      <input
                        type="checkbox"
                        className="accent-primary"
                        checked={sel.size === entries.length && entries.length > 0}
                        onChange={(e) => setSel(e.target.checked ? new Set(entries.map((x) => x.name)) : new Set())}
                      />
                    </th>
                    <th className="border-b border-border/60 px-3 py-2 font-medium">Name</th>
                    <th className="w-28 border-b border-border/60 px-3 py-2 text-right font-medium">Size</th>
                    <th className="w-44 border-b border-border/60 px-3 py-2 font-medium">Last Modified</th>
                    <th className="w-12 border-b border-border/60 px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {entries.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-10 text-center text-muted-foreground">This directory is empty.</td>
                    </tr>
                  )}
                  {entries.map((e) => (
                    <tr key={e.name} className={cn("group hover:bg-muted/40", sel.has(e.name) && "bg-primary/5")}>
                      <td className="border-b border-border/30 px-3 py-1.5">
                        <input
                          type="checkbox"
                          className="accent-primary"
                          checked={sel.has(e.name)}
                          onChange={(ev) =>
                            setSel((s) => {
                              const next = new Set(s);
                              if (ev.target.checked) next.add(e.name);
                              else next.delete(e.name);
                              return next;
                            })
                          }
                        />
                      </td>
                      <td className="border-b border-border/30 px-3 py-1.5">
                        <button
                          onClick={() => (e.type === "dir" ? setPath(joinPath(path, e.name)) : void openEditor(e.name))}
                          className="flex items-center gap-2 text-left font-medium text-foreground/90 transition-colors hover:text-primary"
                        >
                          {e.type === "dir" ? <Folder className="size-4 text-primary/80" /> : <FileText className="size-4 text-muted-foreground" />}
                          <span className="truncate">{e.name}</span>
                        </button>
                      </td>
                      <td className="border-b border-border/30 px-3 py-1.5 text-right font-mono text-[12px] text-muted-foreground tabular-nums">
                        {e.type === "dir" ? "—" : formatBytes(e.size)}
                      </td>
                      <td className="border-b border-border/30 px-3 py-1.5 text-[12px] text-muted-foreground tabular-nums">
                        {e.mtime ? new Date(e.mtime * 1000).toLocaleString() : "—"}
                      </td>
                      <td className="border-b border-border/30 px-2 py-1.5">
                        <div className="relative">
                          <button
                            onClick={() => setMenuFor(menuFor === e.name ? null : e.name)}
                            title="More options"
                            className="rounded-lg p-1.5 text-muted-foreground opacity-0 transition-all hover:bg-muted group-hover:opacity-100"
                          >
                            <MoreHorizontal className="size-4" />
                          </button>
                          {menuFor === e.name && (
                            <>
                              <div className="fixed inset-0 z-30" onClick={() => setMenuFor(null)} />
                              <div className="absolute right-0 top-full z-40 mt-1 w-44 overflow-hidden rounded-xl border border-border/60 bg-popover p-1 shadow-xl">
                                <MenuItem
                                  icon={e.type === "dir" ? <Folder className="size-3.5" /> : <FileText className="size-3.5" />}
                                  label={e.type === "dir" ? "Open" : "Edit"}
                                  onClick={() => {
                                    setMenuFor(null);
                                    e.type === "dir" ? setPath(joinPath(path, e.name)) : void openEditor(e.name);
                                  }}
                                />
                                <MenuItem
                                  icon={<Download className="size-3.5" />}
                                  label="Download"
                                  disabled={e.type === "dir"}
                                  onClick={() => {
                                    setMenuFor(null);
                                    void downloadFile(e.name);
                                  }}
                                />
                                <MenuItem
                                  icon={<Pencil className="size-3.5" />}
                                  label="Rename"
                                  onClick={() => {
                                    setMenuFor(null);
                                    setRenameTarget({ path: joinPath(path, e.name), name: e.name });
                                    setRenameTo(e.name);
                                  }}
                                />
                                <div className="my-1 h-px bg-border/50" />
                                <MenuItem
                                  icon={<Trash2 className="size-3.5" />}
                                  label="Delete"
                                  danger
                                  onClick={() => {
                                    setMenuFor(null);
                                    setDeleteTarget({ path: joinPath(path, e.name), name: e.name });
                                  }}
                                />
                              </div>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Editor modal */}
      <Modal isOpen={!!editor} onClose={() => !saving && setEditor(null)} maxWidth="720px" showCloseButton={!saving}>
        {editor && (
          <div className="p-5">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <FileText className="size-4 text-muted-foreground" /> Editing <span className="font-mono text-primary">{displayPath(editor.path)}</span>
            </h2>
            <textarea
              value={editor.content}
              onChange={(e) => setEditor({ ...editor, content: e.target.value })}
              spellCheck={false}
              className="mt-4 h-[55vh] w-full resize-none rounded-xl border border-border/60 bg-black/40 p-3 font-mono text-[12.5px] leading-relaxed text-foreground focus:border-primary/50 focus:outline-none"
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditor(null)} disabled={saving}>Cancel</Button>
              <Button onClick={() => void saveFile()} disabled={saving}>
                {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} Save
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Create dir / new file modal */}
      <Modal isOpen={!!mkModal} onClose={() => !mkBusy && setMkModal(null)} maxWidth="440px" showCloseButton={!mkBusy}>
        <div className="p-6">
          <h2 className="text-sm font-semibold">{mkModal === "dir" ? "Create Directory" : "New File"}</h2>
          <p className="mt-1 font-mono text-[12.5px] text-muted-foreground">{displayPath(path)}</p>
          <Input
            value={mkName}
            onChange={(e) => setMkName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submitMk()}
            placeholder={mkModal === "dir" ? "directory name" : "file name (e.g. server.properties)"}
            autoFocus
            className="mt-4 h-9"
          />
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setMkModal(null)} disabled={mkBusy}>Cancel</Button>
            <Button onClick={() => void submitMk()} disabled={mkBusy || !mkName.trim()}>
              {mkBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Create
            </Button>
          </div>
        </div>
      </Modal>

      {/* Rename modal */}
      <Modal isOpen={!!renameTarget} onClose={() => !renameBusy && setRenameTarget(null)} maxWidth="440px" showCloseButton={!renameBusy}>
        <div className="p-6">
          <h2 className="text-sm font-semibold">Rename <span className="font-mono text-primary">{renameTarget?.name}</span></h2>
          <Input
            value={renameTo}
            onChange={(e) => setRenameTo(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submitRename()}
            autoFocus
            className="mt-4 h-9"
          />
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setRenameTarget(null)} disabled={renameBusy}>Cancel</Button>
            <Button onClick={() => void submitRename()} disabled={renameBusy || !renameTo.trim()}>
              {renameBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Pencil className="size-3.5" />} Rename
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
        loading={deleting}
        title="Delete file"
        description="This permanently removes the file or directory from the server volume."
        resourceName={deleteTarget?.name ?? ""}
        confirmLabel="Delete"
      />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
   Schedules — cron tasks
   ───────────────────────────────────────────────────────────────── */

interface GameSchedule {
  id: string;
  gameServerId: string;
  name: string;
  cron: string;
  command: string;
  enabled: boolean;
  onlyOnline: boolean;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  createdAt: string;
}

const CRON_FIELDS: { key: string; label: string; hint: string; def: string }[] = [
  { key: "minute", label: "MINUTE", hint: "0-59", def: "*" },
  { key: "hour", label: "HOUR", hint: "0-23", def: "*" },
  { key: "dom", label: "DAY OF MONTH", hint: "1-31", def: "*" },
  { key: "month", label: "MONTH", hint: "1-12", def: "*" },
  { key: "dow", label: "DAY OF WEEK", hint: "0-7", def: "*" },
];

function SchedulesTab({ game }: { game: GameServer }) {
  const { toast } = useToast();
  const id = game.id;
  const [items, setItems] = useState<GameSchedule[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState({
    name: "", minute: "*", hour: "*", dom: "*", month: "*", dow: "*",
    command: "", enabled: true, onlyOnline: false, showCheat: false,
  });
  const [creating, setCreating] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [delId, setDelId] = useState<string | null>(null);
  const [delBusy, setDelBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await get<{ items: GameSchedule[] }>(`/game-servers/${id}/schedules`);
      setItems(res.items);
    } catch (e) {
      toast("error", "Failed to load schedules", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const cronValue = `${form.minute} ${form.hour} ${form.dom} ${form.month} ${form.dow}`.replace(/\s+/g, " ").trim();

  const create = async () => {
    if (!form.name.trim()) {
      toast("error", "Name required", "Give the schedule a name.");
      return;
    }
    setCreating(true);
    try {
      const res = await post<{ schedule: GameSchedule }>(`/game-servers/${id}/schedules`, {
        name: form.name.trim(),
        cron: cronValue,
        command: form.command.trim(),
        enabled: form.enabled,
        onlyOnline: form.onlyOnline,
      });
      toast("success", "Schedule created", res.schedule.name);
      setModalOpen(false);
      void load();
    } catch (e) {
      toast("error", "Create failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setCreating(false);
    }
  };

  const runNow = async (s: GameSchedule) => {
    setRunningId(s.id);
    try {
      const res = await post<{ ran: boolean; message: string }>(`/game-schedules/${s.id}/run`);
      toast(res.ran ? "success" : "info", res.ran ? "Schedule executed" : "Schedule fired", res.message || s.name);
      void load();
    } catch (e) {
      toast("error", "Run failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setRunningId(null);
    }
  };

  const toggleEnabled = async (s: GameSchedule) => {
    try {
      await patch(`/game-schedules/${s.id}`, { enabled: !s.enabled });
      void load();
    } catch (e) {
      toast("error", "Update failed", e instanceof Error ? e.message : "Unknown error");
    }
  };

  const confirmDelete = async () => {
    if (!delId) return;
    setDelBusy(true);
    try {
      await del(`/game-schedules/${delId}`);
      toast("success", "Schedule deleted", "");
      setDelId(null);
      void load();
    } catch (e) {
      toast("error", "Delete failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setDelBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Schedules</h2>
          <p className="text-[13px] text-muted-foreground">Run console/shell commands on a cron schedule.</p>
        </div>
        <Button onClick={() => setModalOpen(true)}>
          <Plus className="size-3.5" /> New schedule
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading && items === null && <Skeleton className="h-40 rounded-none" />}
          {!loading && (items ?? []).length === 0 && (
            <p className="px-4 py-14 text-center text-sm text-muted-foreground">No schedules yet — create one to automate commands.</p>
          )}
          {(items ?? []).length > 0 && (
            <div className="divide-y divide-border/50">
              {items!.map((s) => (
                <div key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">{s.name}</p>
                      <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">{s.cron}</span>
                      {s.onlyOnline && <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-500">ONLINE ONLY</span>}
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[12px] text-muted-foreground">{s.command || "(no command)"}</p>
                    <p className="mt-0.5 text-[11.5px] text-muted-foreground/70">
                      {s.nextRunAt ? `Next: ${timeAgo(s.nextRunAt)} · ` : ""}Last run: {s.lastRunAt ? timeAgo(s.lastRunAt) : "never"}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => void runNow(s)} disabled={runningId === s.id} title="Run now">
                    {runningId === s.id ? <Loader2 className="size-3.5 animate-spin" /> : <PlayCircle className="size-3.5" />} Run now
                  </Button>
                  <Switch checked={s.enabled} onChange={() => void toggleEnabled(s)} />
                  <button onClick={() => setDelId(s.id)} className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive" title="Delete">
                    <Trash2 className="size-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create modal */}
      <Modal isOpen={modalOpen} onClose={() => !creating && setModalOpen(false)} maxWidth="560px" showCloseButton={!creating}>
        <div className="p-6">
          <h2 className="text-sm font-semibold">Create schedule</h2>
          <label className="mt-4 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Schedule Name</label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Daily restart" className="mt-1.5 h-9" />

          <p className="mt-4 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Cron Syntax</p>
          <div className="mt-1.5 grid grid-cols-5 gap-2">
            {CRON_FIELDS.map((f) => (
              <div key={f.key}>
                <input
                  value={form[f.key as keyof typeof form] as string}
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                  placeholder={f.def}
                  spellCheck={false}
                  className="h-9 w-full rounded-lg border border-border/60 bg-background px-2 text-center font-mono text-[12px] text-foreground placeholder:text-muted-foreground/40 focus:border-primary/50 focus:outline-none"
                />
                <p className="mt-1 text-center text-[10px] font-medium uppercase text-muted-foreground/70">{f.label}</p>
                <p className="text-center text-[10px] text-muted-foreground/50">{f.hint}</p>
              </div>
            ))}
          </div>
          <p className="mt-2 rounded-lg bg-muted/60 px-2.5 py-1.5 font-mono text-[12px] text-primary">{cronValue}</p>

          <label className="mt-4 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Command</label>
          <Input
            value={form.command}
            onChange={(e) => setForm({ ...form, command: e.target.value })}
            placeholder="e.g. rcon-cli say Restarting soon — or any shell command"
            className="mt-1.5 h-9 font-mono text-[12.5px]"
          />

          <div className="mt-4 space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-[12.5px] font-medium">SHOW CHEATSHEET</label>
              <Switch checked={form.showCheat} onChange={(v) => setForm({ ...form, showCheat: v })} />
            </div>
            <div className="flex items-center justify-between">
              <label className="text-[12.5px] font-medium">ONLY WHEN SERVER IS ONLINE</label>
              <Switch checked={form.onlyOnline} onChange={(v) => setForm({ ...form, onlyOnline: v })} />
            </div>
            <div className="flex items-center justify-between">
              <label className="text-[12.5px] font-medium">SCHEDULE ENABLED</label>
              <Switch checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} />
            </div>
          </div>

          {form.showCheat && (
            <div className="mt-4 rounded-xl border border-border/60 bg-muted/30 p-3 text-[12px]">
              <p className="mb-2 font-semibold">Cron cheatsheet</p>
              <table className="w-full text-[11.5px]">
                <tbody>
                  {[
                    ["* * * * *", "every minute"],
                    ["*/5 * * * *", "every 5 minutes"],
                    ["0 * * * *", "every hour"],
                    ["0 8 * * *", "daily at 08:00"],
                    ["0 3 * * 0", "Sundays 03:00"],
                    ["*/30 * * * *", "every 30 minutes"],
                  ].map(([expr, desc]) => (
                    <tr key={expr} className="border-b border-border/30 last:border-0">
                      <td className="py-1 pr-3 font-mono text-primary">{expr}</td>
                      <td className="py-1 text-muted-foreground">{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setModalOpen(false)} disabled={creating}>Cancel</Button>
            <Button onClick={() => void create()} disabled={creating}>
              {creating ? <Loader2 className="size-3.5 animate-spin" /> : <CalendarClock className="size-3.5" />} Create schedule
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!delId}
        onClose={() => setDelId(null)}
        onConfirm={() => void confirmDelete()}
        loading={delBusy}
        title="Delete schedule"
        description="The schedule will no longer fire. This does not affect the server."
        resourceName={items?.find((s) => s.id === delId)?.name ?? ""}
        confirmLabel="Delete"
      />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
   Backups — volume snapshot cards
   ───────────────────────────────────────────────────────────────── */

interface GameBackup {
  id: string;
  status: string;
  sizeBytes?: number | null;
  sha1?: string | null;
  locked?: boolean;
  createdAt: string;
}

function BackupsTab({ game }: { game: GameServer }) {
  const { toast } = useToast();
  const id = game.id;
  const [items, setItems] = useState<GameBackup[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<GameBackup | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [delTarget, setDelTarget] = useState<GameBackup | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = async () => {
    try {
      const res = await get<{ items: GameBackup[] }>(`/game-servers/${id}/backups`);
      setItems(res.items);
    } catch (e) {
      toast("error", "Failed to load backups", e instanceof Error ? e.message : "Unknown error");
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Poll while a backup is running.
  useEffect(() => {
    if (!items?.some((b) => b.status === "PENDING" || b.status === "RUNNING")) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const create = async () => {
    setCreating(true);
    try {
      await post(`/game-servers/${id}/backup`);
      toast("success", "Backup started", "Snapshoting the volume…");
      setTimeout(() => void load(), 1000);
    } catch (e) {
      toast("error", "Backup failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setCreating(false);
    }
  };

  const restore = async () => {
    if (!restoreTarget) return;
    setRestoring(true);
    try {
      await post(`/backups/${restoreTarget.id}/restore`);
      toast("success", "Restore started", "The server volume is being restored…");
      setRestoreTarget(null);
    } catch (e) {
      toast("error", "Restore failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setRestoring(false);
    }
  };

  const toggleLock = async (b: GameBackup) => {
    try {
      await put(`/backups/${b.id}/lock`, { locked: !b.locked });
      toast("success", b.locked ? "Backup unlocked" : "Backup locked", "");
      void load();
    } catch (e) {
      toast("error", "Failed", e instanceof Error ? e.message : "Unknown error");
    }
  };

  const confirmDelete = async () => {
    if (!delTarget) return;
    setDeleting(true);
    try {
      await del(`/game-backups/${delTarget.id}`);
      toast("success", "Backup deleted", "");
      setDelTarget(null);
      void load();
    } catch (e) {
      toast("error", "Delete failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setDeleting(false);
    }
  };

  const successCount = items?.filter((b) => b.status === "SUCCESS").length ?? 0;
  const totalSize = items?.filter((b) => b.status === "SUCCESS").reduce((a, b) => a + (b.sizeBytes ?? 0), 0) ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Backups</h2>
          <p className="text-[13px] text-muted-foreground">Volume snapshots of {game.name} — you can download, restore, lock or delete them.</p>
        </div>
        <Button onClick={() => void create()} disabled={creating}>
          {creating ? <Loader2 className="size-3.5 animate-spin" /> : <Archive className="size-3.5" />} Create backup
        </Button>
      </div>

      <div className="space-y-3">
        {(items ?? []).map((b) => (
          <Card key={b.id} className="relative">
            <CardContent className="flex flex-wrap items-center gap-4 px-4 py-3.5">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                {b.status === "RUNNING" || b.status === "PENDING" ? <Loader2 className="size-4 animate-spin" /> : b.locked ? <Lock className="size-4 text-amber-500" /> : <Archive className="size-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold">{b.id.replace("bak_", "").slice(0, 6)}</p>
                  <StatusBadge status={b.status} />
                  {b.locked && <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-medium text-amber-500">LOCKED</span>}
                </div>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  {formatBytes(b.sizeBytes)} · {timeAgo(b.createdAt)}
                </p>
                {b.sha1 && (
                  <button
                    onClick={() => void navigator.clipboard?.writeText(b.sha1!)}
                    title="Copy SHA-1"
                    className="mt-1 flex items-center gap-1 font-mono text-[11px] text-muted-foreground/70 transition-colors hover:text-foreground"
                  >
                    <Lock className="size-3" /> {b.sha1.slice(0, 18)}…
                  </button>
                )}
              </div>

              <div className="relative">
                <Button size="sm" variant="outline" onClick={() => setMenuFor(menuFor === b.id ? null : b.id)}>
                  <MoreHorizontal className="size-4" />
                </Button>
                {menuFor === b.id && (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setMenuFor(null)} />
                    <div className="absolute right-0 top-full z-40 mt-1 w-44 overflow-hidden rounded-xl border border-border/60 bg-popover p-1 shadow-xl">
                      <MenuItem
                        icon={<Download className="size-3.5" />}
                        label="Download"
                        onClick={() => {
                          setMenuFor(null);
                          void downloadBackup(b.id, `${game.name}-${b.id.slice(-6)}.tar.gz`).catch((e) =>
                            toast("error", "Download failed", e instanceof Error ? e.message : "Unknown error"),
                          );
                        }}
                      />
                      <MenuItem
                        icon={<RefreshCw className="size-3.5" />}
                        label="Restore"
                        disabled={b.status !== "SUCCESS"}
                        onClick={() => {
                          setMenuFor(null);
                          setRestoreTarget(b);
                        }}
                      />
                      <MenuItem
                        icon={b.locked ? <Unlock className="size-3.5" /> : <Lock className="size-3.5" />}
                        label={b.locked ? "Unlock" : "Lock"}
                        onClick={() => {
                          setMenuFor(null);
                          void toggleLock(b);
                        }}
                      />
                      <div className="my-1 h-px bg-border/50" />
                      <MenuItem
                        icon={<Trash2 className="size-3.5" />}
                        label="Delete"
                        danger
                        disabled={b.locked}
                        onClick={() => {
                          setMenuFor(null);
                          setDelTarget(b);
                        }}
                      />
                    </div>
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
        {(items ?? []).length === 0 && (
          <Card>
            <CardContent className="py-14 text-center">
              <Archive className="mx-auto size-10 text-muted-foreground/40" />
              <p className="mt-3 text-sm font-medium">No backups yet</p>
              <p className="mt-1 text-[13px] text-muted-foreground">Create a backup to snapshot the server volume.</p>
            </CardContent>
          </Card>
        )}
      </div>

      <p className="text-center text-[12px] text-muted-foreground/70">
        {successCount} of {items?.length ?? 0} backups · {formatBytes(totalSize)} total · NEXUS
      </p>

      <ConfirmDialog
        open={!!restoreTarget}
        onClose={() => setRestoreTarget(null)}
        onConfirm={() => void restore()}
        loading={restoring}
        title="Restore backup"
        description="The server will be stopped, the volume replaced from this snapshot, and the server started again."
        resourceName={restoreTarget?.id.replace("bak_", "").slice(0, 6) ?? ""}
        confirmLabel="Restore"
      />
      <ConfirmDialog
        open={!!delTarget}
        onClose={() => setDelTarget(null)}
        onConfirm={() => void confirmDelete()}
        loading={deleting}
        title="Delete backup"
        description="This removes the backup file from the agent host. This cannot be undone."
        resourceName={delTarget?.id.replace("bak_", "").slice(0, 6) ?? ""}
        confirmLabel="Delete"
      />
    </div>
  );
}

function MenuItem({
  icon, label, onClick, danger = false, disabled = false,
}: {
  icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean; disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] transition-colors",
        disabled ? "cursor-not-allowed opacity-40" : danger ? "text-destructive hover:bg-destructive/10" : "text-foreground hover:bg-muted",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/* ─────────────────────────────────────────────────────────────────
   Network — allocations
   ───────────────────────────────────────────────────────────────── */

interface GameAllocation {
  id: string;
  ip: string;
  port: number;
  notes?: string | null;
  isPrimary: boolean;
}

function NetworkTab({ game }: { game: GameServer }) {
  const { toast } = useToast();
  const id = game.id;
  const [items, setItems] = useState<GameAllocation[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [savingNotes, setSavingNotes] = useState<string | null>(null);
  const [primaryBusy, setPrimaryBusy] = useState(false);

  const load = async () => {
    try {
      const res = await get<{ items: GameAllocation[] }>(`/game-servers/${id}/allocations`);
      setItems(res.items);
      setNotes((prev) => {
        const next = { ...prev };
        for (const a of res.items) next[a.id] = a.notes ?? "";
        return next;
      });
    } catch (e) {
      toast("error", "Failed to load allocations", e instanceof Error ? e.message : "Unknown error");
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const saveNotes = async (a: GameAllocation) => {
    setSavingNotes(a.id);
    try {
      const res = await patch<{ allocation: GameAllocation }>(`/game-allocations/${a.id}`, { notes: notes[a.id] ?? "" });
      toast("success", "Notes saved", `${res.allocation.ip}:${res.allocation.port}`);
      void load();
    } catch (e) {
      toast("error", "Save failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setSavingNotes(null);
    }
  };

  const setPrimary = async (a: GameAllocation) => {
    setPrimaryBusy(true);
    try {
      await post(`/game-servers/${id}/allocations/${a.id}/primary`);
      toast("success", "Primary allocation set", `${a.ip}:${a.port}`);
      void load();
    } catch (e) {
      toast("error", "Failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setPrimaryBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Network</h2>
        <p className="text-[13px] text-muted-foreground">Network allocations assigned to {game.name}.</p>
      </div>

      {(items ?? []).map((a) => (
        <Card key={a.id} className={cn(a.isPrimary && "border-primary/40")}>
          <CardContent className="flex flex-wrap items-center gap-4 px-4 py-4">
            <div className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl", a.isPrimary ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
              <NetworkIcon className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">IP Address</span>
                <span className="font-mono text-sm font-semibold">{a.ip}</span>
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Port</span>
                <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-sm font-semibold">{a.port}</span>
                {a.isPrimary ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[10.5px] font-semibold text-primary-foreground">
                    <Star className="size-3" /> PRIMARY
                  </span>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => void setPrimary(a)} disabled={primaryBusy}>
                    <Star className="size-3" /> Set primary
                  </Button>
                )}
              </div>
              <div className="mt-3 flex items-end gap-2">
                <Input
                  value={notes[a.id] ?? ""}
                  onChange={(e) => setNotes((n) => ({ ...n, [a.id]: e.target.value }))}
                  placeholder="Notes — e.g. 'primary server, keep this port'"
                  className="h-8 max-w-md text-[12.5px]"
                  onKeyDown={(e) => e.key === "Enter" && void saveNotes(a)}
                />
                <Button size="sm" variant="outline" onClick={() => void saveNotes(a)} disabled={savingNotes === a.id}>
                  {savingNotes === a.id ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} Save
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
      {(items ?? []).length === 0 && (
        <Card>
          <CardContent className="py-14 text-center">
            <NetworkIcon className="mx-auto size-10 text-muted-foreground/40" />
            <p className="mt-3 text-sm font-medium">No allocations</p>
            <p className="mt-1 text-[13px] text-muted-foreground">No network allocations are assigned to this server.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
   Startup — command, docker image, variables
   ───────────────────────────────────────────────────────────────── */

function StartupTab({ game }: { game: GameServer }) {
  const { toast } = useToast();
  const id = game.id;
  const [startup, setStartup] = useState<{ image: string; images: string[]; environment: Record<string, string>; command: string } | null>(null);
  const [image, setImage] = useState("");
  const [env, setEnv] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const res = await get<{ image: string; images: string[]; environment: Record<string, string>; command: string }>(`/game-servers/${id}/startup`);
      setStartup(res);
      setImage(res.image);
      setEnv({ ...res.environment });
    } catch (e) {
      toast("error", "Failed to load startup", e instanceof Error ? e.message : "Unknown error");
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await put<{ gameServer: GameServer; applied: boolean }>(`/game-servers/${id}/startup`, { image, environment: env });
      toast(
        "success",
        "Startup saved",
        res.applied ? "The container was recreated with the new settings." : "Settings saved — the container will apply them on next deploy.",
      );
      void load();
    } catch (e) {
      toast("error", "Save failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  };

  const setVar = (k: string, v: string) => setEnv((e) => ({ ...e, [k]: v }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Startup</h2>
          <p className="text-[13px] text-muted-foreground">Configure how the server container starts — image, memory, versions.</p>
        </div>
        <Button onClick={() => void save()} disabled={saving || !startup}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} Save &amp; reinstall
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-[13px] font-medium">STARTUP COMMAND</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-xl bg-black/70 p-3.5 font-mono text-[12.5px] leading-relaxed text-emerald-300">
            {startup?.command ?? "Loading…"}
          </div>
          <p className="mt-2 text-[12px] text-muted-foreground">
            The image entrypoint runs this on boot. Memory flags come from the <span className="font-mono">MEMORY</span> variable below.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-[13px] font-medium">DOCKER IMAGE</CardTitle>
        </CardHeader>
        <CardContent>
          <select
            value={image}
            onChange={(e) => setImage(e.target.value)}
            className="h-10 w-full max-w-md rounded-lg border border-border/60 bg-background px-3 font-mono text-[13px] text-foreground focus:border-primary/50 focus:outline-none"
          >
            {startup?.images.map((img) => (
              <option key={img} value={img}>itzg/minecraft-server:{img}</option>
            ))}
            {image && !startup?.images.includes(image) && <option value={image}>{image}</option>}
          </select>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-[13px] font-medium">Variables</CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setVar(`VAR_${Object.keys(env).length + 1}`, "")}
          >
            <Plus className="size-3.5" /> Add variable
          </Button>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {Object.entries(env).map(([k, v]) => (
            <div key={k} className="flex items-center gap-2">
              <span className="w-40 shrink-0 truncate font-mono text-[12px] text-muted-foreground" title={k}>{k}</span>
              <Input
                value={v}
                onChange={(e) => setVar(k, e.target.value)}
                spellCheck={false}
                className="h-9 font-mono text-[12.5px]"
              />
              <button
                onClick={() => setEnv((e) => {
                  const next = { ...e };
                  delete next[k];
                  return next;
                })}
                className="rounded-lg p-1.5 text-muted-foreground/60 transition-colors hover:bg-destructive/10 hover:text-destructive"
                title="Remove variable"
              >
                <X className="size-4" />
              </button>
            </div>
          ))}
          {Object.keys(env).length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">No variables.</p>}
        </CardContent>
      </Card>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
   Settings / Activity — lightweight
   ───────────────────────────────────────────────────────────────── */

function SettingsTab({ game }: { game: GameServer }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <MetricCard icon={<Cpu className="size-3.5" />} label="CPU limit" value={game.cpuLimit ? `${game.cpuLimit} cores` : "Unlimited"} />
      <MetricCard icon={<MemoryStick className="size-3.5" />} label="Memory" value={formatBytes(game.memoryBytes)} />
      <MetricCard icon={<HardDrive className="size-3.5" />} label="Storage" value={formatBytes(game.storageBytes)} />
      <MetricCard icon={<Radio className="size-3.5" />} label="Primary port" value={String(game.port)} mono />
      <MetricCard icon={<FolderTree className="size-3.5" />} label="Volume" value={game.volumeName ?? "—"} mono />
      <MetricCard icon={<TerminalSquare className="size-3.5" />} label="Image" value={game.image} mono />
    </div>
  );
}

interface AuditItem {
  id: string;
  action: string;
  resourceName?: string | null;
  resourceId?: string | null;
  createdAt: string;
  metadata?: string | null;
}

function ActivityTab({ game }: { game: GameServer }) {
  const [items, setItems] = useState<AuditItem[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const res = await get<{ items: AuditItem[] }>(`/audit?resourceType=game-server&limit=50`);
        setItems(res.items.filter((i) => i.resourceId === game.id));
      } catch {
        setItems([]);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.id]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[13px] font-medium">Recent activity</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <Skeleton className="h-40 rounded-none" />
        ) : (items ?? []).length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-muted-foreground">No activity recorded yet.</p>
        ) : (
          <div className="divide-y divide-border/50">
            {(items ?? []).slice(0, 25).map((i) => (
              <div key={i.id} className="flex items-center gap-3 px-4 py-2.5">
                <ActivityIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{i.action}</span>
                <span className="shrink-0 text-[11.5px] text-muted-foreground">{timeAgo(i.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
