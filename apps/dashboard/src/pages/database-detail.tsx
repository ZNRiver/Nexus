import { useEffect, useRef, useState, type ComponentType } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  KeyRound, Copy, Trash2, DatabaseBackup, Loader2, ExternalLink,
  Rocket, RefreshCw, Play, Terminal, Eye, EyeOff, Activity, LayoutGrid, Layers, ScrollText, Settings2,
  HardDrive as HardDriveIcon, Cpu as CpuIcon, MemoryStick as MemoryIcon, CalendarClock, Save, Download, Upload, UploadCloud,
  SquareTerminal, Table2, PlayCircle, Clock3, Database as DatabaseIcon, FolderTree, ChevronRight, ChevronDown,
  Filter, Columns3, Link2, Zap, ListTree, Search, Server, Users, Info, Wrench,
} from "lucide-react";
import { get, post, put, del, downloadBackup } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, type TabDef } from "@/components/ui/Tabs";
import { Modal } from "@/components/ui/Modal";
import { StatusBadge } from "@/components/status-badge";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Skeleton } from "@/components/skeleton";
import { useToast } from "@/components/toast";
import { formatBytes, formatTime, timeAgo } from "@/lib/format";
import { DbLogo, DB_COLORS } from "@/components/db-logos";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/utils";
import type { Backup, Database, DatabaseConnectionInfo } from "@nexus/types";

type TabKey = "general" | "console" | "database" | "environment" | "logs" | "monitoring" | "backups" | "advanced";

const TABS: TabDef<TabKey>[] = [
  { key: "general", label: "General", icon: LayoutGrid },
  { key: "console", label: "Console", icon: SquareTerminal },
  { key: "database", label: "Database", icon: DatabaseIcon },
  { key: "environment", label: "Environment", icon: Layers },
  { key: "logs", label: "Logs", icon: ScrollText },
  { key: "monitoring", label: "Monitoring", icon: Activity },
  { key: "backups", label: "Backups", icon: DatabaseBackup },
  { key: "advanced", label: "Advanced", icon: Settings2 },
];

export function DatabaseDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<TabKey>("general");
  const [revealed, setRevealed] = useState<DatabaseConnectionInfo | null>(null);
  const [secretsVisible, setSecretsVisible] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleCron, setScheduleCron] = useState("0 2 * * *");
  const [scheduleRetention, setScheduleRetention] = useState(7);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [execOpen, setExecOpen] = useState(false);
  const [execCmd, setExecCmd] = useState("");
  const [execOut, setExecOut] = useState("");
  const [execBusy, setExecBusy] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["database-detail", id],
    queryFn: () =>
      get<{ database: Database; connection: DatabaseConnectionInfo | null; credentials: { id: string; username: string; passwordMasked: string }[]; backups: Backup[]; server?: { id: string; name: string } | null }>(
        `/databases/${id}`,
      ),
    refetchInterval: 8000,
  });

  const logsQ = useQuery({
    queryKey: ["database-logs", id],
    queryFn: () => get<{ logs: string }>(`/databases/${id}/logs`),
    enabled: tab === "logs",
    refetchInterval: tab === "logs" ? 5000 : false,
    retry: false,
  });

  const envQ = useQuery({
    queryKey: ["database-env", id],
    queryFn: () => get<{ env: { key: string; value: string }[] }>(`/databases/${id}/env`),
    enabled: tab === "environment",
    retry: false,
  });

  const statsQ = useQuery({
    queryKey: ["database-stats", id],
    queryFn: () => get<{ cpuPercent: number; memoryUsageBytes: number; memoryLimitBytes: number }>(`/databases/${id}/stats`),
    enabled: tab === "monitoring",
    refetchInterval: tab === "monitoring" ? 5000 : false,
    retry: false,
  });

  const containerName = id ? `nexus-db-${id.replace("db_", "")}` : "";

  // Sync schedule form with the loaded database (once).
  useEffect(() => {
    if (data?.database.backupSchedule) {
      const s = data.database.backupSchedule;
      setScheduleEnabled(s.enabled);
      setScheduleCron(s.cron || "0 2 * * *");
      setScheduleRetention(s.retention || 7);
    }
  }, [data?.database.id]);

  const runAction = async (action: "deploy" | "restart" | "start", label: string) => {
    setActionBusy(action);
    try {
      await post(`/databases/${id}/${action}`);
      toast("success", `${label} successful`);
      queryClient.invalidateQueries({ queryKey: ["database-detail", id] });
    } catch (err) {
      toast("error", `${label} failed`, err instanceof Error ? err.message : "Unknown error");
    } finally {
      setActionBusy(null);
    }
  };

  const reveal = async () => {
    setRevealing(true);
    try {
      const info = await post<DatabaseConnectionInfo>(`/databases/${id}/connection/reveal`);
      setRevealed(info);
      setSecretsVisible(true);
    } catch (err) {
      toast("error", "Reveal failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setRevealing(false);
    }
  };

  const toggleSecret = () => {
    if (secretsVisible) {
      setSecretsVisible(false);
    } else if (revealed) {
      setSecretsVisible(true);
    } else {
      void reveal();
    }
  };

  const backup = async () => {
    setBackingUp(true);
    try {
      await post(`/databases/${id}/backup`);
      toast("success", "Backup started", "The agent is snapshotting the database");
      queryClient.invalidateQueries({ queryKey: ["database-detail", id] });
    } catch (err) {
      toast("error", "Backup failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBackingUp(false);
    }
  };

  const restore = async (b: Backup) => {
    try {
      await post(`/backups/${b.id}/restore`);
      toast("success", "Restore started", `Restoring ${b.id.slice(-8)}`);
      queryClient.invalidateQueries({ queryKey: ["database-detail", id] });
    } catch (err) {
      toast("error", "Restore failed", err instanceof Error ? err.message : "Unknown error");
    }
  };

  const download = async (b: Backup) => {
    try {
      await downloadBackup(b.id, `${db.name}-${b.id.slice(-8)}.dump`);
      toast("success", "Download started", b.id.slice(-8));
    } catch (err) {
      toast("error", "Download failed", err instanceof Error ? err.message : "Unknown error");
    }
  };

  const uploadBackup = async () => {
    if (!uploadFile) return;
    setUploading(true);
    try {
      const query = new URLSearchParams({ serverId: db.serverId, kind: "DATABASE", databaseId: id });
      const res = await fetch(`/api/v1/backups/upload?${query}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/octet-stream" },
        body: uploadFile,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ?? `Upload failed (${res.status})`);
      toast("success", "Backup uploaded", `${uploadFile.name}`);
      setUploadOpen(false);
      setUploadFile(null);
      queryClient.invalidateQueries({ queryKey: ["database-detail", id] });
    } catch (err) {
      toast("error", "Upload failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setUploading(false);
    }
  };

  const saveSchedule = async () => {
    setScheduleSaving(true);
    try {
      await put(`/databases/${id}/backup-schedule`, {
        enabled: scheduleEnabled,
        cron: scheduleCron.trim() || "0 2 * * *",
        retention: scheduleRetention,
      });
      toast("success", scheduleEnabled ? "Scheduled backups enabled" : "Scheduled backups disabled");
      queryClient.invalidateQueries({ queryKey: ["database-detail", id] });
    } catch (err) {
      toast("error", "Failed to save schedule", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setScheduleSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await del(`/databases/${id}`);
      toast("success", "Database removed", data?.database.name);
      queryClient.invalidateQueries({ queryKey: ["databases"] });
      navigate("/databases");
    } catch (err) {
      toast("error", "Delete failed", err instanceof Error ? err.message : "Unknown error");
      setDeleting(false);
    }
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => toast("success", "Copied to clipboard"));
  };

  const runExec = async () => {
    const cmd = execCmd.trim().split(/\s+/).filter(Boolean);
    if (cmd.length === 0) return;
    setExecBusy(true);
    try {
      const res = await post<{ output: string; exitCode: number }>(`/databases/${id}/exec`, { cmd });
      setExecOut(res.output || `(exit ${res.exitCode})`);
    } catch (err) {
      setExecOut(err instanceof Error ? `✗ ${err.message}` : "✗ Unknown error");
    } finally {
      setExecBusy(false);
    }
  };

  if (isLoading || !data) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-10" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  const { database: db, connection, backups } = data;
  const conn = revealed ?? connection;
  const passwordShown = !!(revealed && secretsVisible);
  const canRun = db.status === "RUNNING";
  const busy = actionBusy !== null;

  const passwordDisplay = passwordShown ? revealed!.password : connection?.password ?? "••••••••";
  const uriDisplay = passwordShown ? revealed!.uri : connection?.uri ?? "••••••••••••••••••••";

  const stats = statsQ.data;
  const statsError = statsQ.error ? (statsQ.error as Error).message : null;

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-muted-foreground">Database</p>
          <div className="mt-1 flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{db.name}</h1>
            <StatusBadge status={db.status} />
          </div>
          <p className="mt-1 font-mono text-[13px] text-muted-foreground">{containerName}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {db.type} {db.version?.split(":")[1] ?? db.version} · {db.image} · {data.server?.name ?? db.serverId}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={backup} disabled={backingUp || !canRun}>
            {backingUp ? <Loader2 className="size-4 animate-spin" /> : <DatabaseBackup className="size-4" />} Backup
          </Button>
          <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
            <Trash2 className="size-4" /> Delete
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="mt-6">
        <Tabs tabs={TABS} value={tab} onChange={setTab} />
      </div>

      <div className="mt-6">
        {tab === "general" && (
          <div className="space-y-6">
            {/* Deploy Settings */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Deploy Settings</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Button onClick={() => runAction("deploy", "Deploy")} disabled={busy || db.status === "CREATING"}>
                  {actionBusy === "deploy" ? <Loader2 className="size-4 animate-spin" /> : <Rocket className="size-4" />} Deploy
                </Button>
                <Button variant="outline" onClick={() => runAction("restart", "Reload")} disabled={busy || !canRun}>
                  {actionBusy === "restart" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Reload
                </Button>
                <Button variant="outline" onClick={() => runAction("start", "Start")} disabled={busy || db.status === "RUNNING" || db.status === "CREATING"}>
                  {actionBusy === "start" ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} Start
                </Button>
                <Button variant="outline" onClick={() => setExecOpen(true)} disabled={!canRun}>
                  <Terminal className="size-4" /> Open Terminal
                </Button>
              </CardContent>
            </Card>

            {/* Internal Credentials */}
            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <KeyRound className="size-4 text-muted-foreground" /> Internal Credentials
                </CardTitle>
                {!revealed && (
                  <Button size="sm" variant="outline" onClick={reveal} disabled={revealing}>
                    {revealing ? <Loader2 className="size-3.5 animate-spin" /> : <Eye className="size-3.5" />} Reveal credentials
                  </Button>
                )}
              </CardHeader>
              <CardContent>
                <div className="grid gap-x-10 gap-y-5 md:grid-cols-2">
                  {/* Left column */}
                  <div className="space-y-5">
                    <SecretField
                      label="User"
                      value={conn?.username ?? db.username ?? "—"}
                      copyValue={conn?.username ?? db.username ?? ""}
                      onCopy={() => copy(conn?.username ?? db.username ?? "")}
                    />
                    <SecretField
                      label="Password"
                      value={passwordDisplay}
                      secret
                      shown={passwordShown}
                      onToggle={toggleSecret}
                      onCopy={() => copy(revealed?.password ?? connection?.password ?? "")}
                    />
                    <SecretField label="Internal Port (Container)" value={String(db.internalPort)} onCopy={() => copy(String(db.internalPort))} />
                    <SecretField
                      label="Internal Connection URL"
                      value={uriDisplay}
                      secret
                      mono
                      shown={passwordShown}
                      onToggle={toggleSecret}
                      onCopy={() => copy(revealed?.uri ?? connection?.uri ?? "")}
                    />
                  </div>
                  {/* Right column */}
                  <div className="space-y-5">
                    <SecretField label="Database Name" value={conn?.database ?? db.dbName ?? db.name} onCopy={() => copy(conn?.database ?? db.dbName ?? db.name)} />
                    <SecretField
                      label="Root Password"
                      value={passwordDisplay}
                      secret
                      shown={passwordShown}
                      onToggle={toggleSecret}
                      onCopy={() => copy(revealed?.password ?? connection?.password ?? "")}
                    />
                    <SecretField label="Internal Host" value={containerName} mono onCopy={() => copy(containerName)} />
                  </div>
                </div>
                {!revealed && (
                  <p className="mt-4 text-xs text-muted-foreground">
                    Credentials are encrypted at rest. Use the eye icon (or “Reveal credentials”) to view the actual password and connection URL.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {tab === "console" && (
          <DbContainerConsole db={db} containerName={containerName} />
        )}

        {tab === "database" && (
          <DbBrowser db={db} />
        )}

        {tab === "environment" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Environment</CardTitle>
            </CardHeader>
            <CardContent>
              {envQ.isLoading ? (
                <Skeleton className="h-24" />
              ) : envQ.error ? (
                <p className="py-6 text-center text-sm text-muted-foreground">{(envQ.error as Error).message}</p>
              ) : (
                <div className="divide-y divide-border/50 rounded-xl border border-border/60">
                  {(envQ.data?.env ?? []).map((e) => (
                    <div key={e.key} className="flex items-center justify-between gap-4 px-4 py-3">
                      <span className="font-mono text-[13px] text-muted-foreground">{e.key}</span>
                      <span className="font-mono text-[13px]">{e.value}</span>
                    </div>
                  ))}
                  {(envQ.data?.env ?? []).length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No environment variables.</p>}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {tab === "logs" && (
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="text-sm">Container Logs</CardTitle>
              <Button size="sm" variant="outline" onClick={() => void logsQ.refetch()} disabled={logsQ.isFetching}>
                <RefreshCw className={cn("size-3.5", logsQ.isFetching && "animate-spin")} /> Refresh
              </Button>
            </CardHeader>
            <CardContent>
              {logsQ.isLoading ? (
                <Skeleton className="h-48" />
              ) : logsQ.error ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {(logsQ.error as Error).message}
                </p>
              ) : (
                <pre className="nexus-terminal max-h-[480px] overflow-auto rounded-xl bg-black/85 p-4 text-zinc-100">
                  {logsQ.data?.logs || "No logs yet."}
                </pre>
              )}
            </CardContent>
          </Card>
        )}

        {tab === "monitoring" && (
          <div className="space-y-6">
            {statsError ? (
              <Card>
                <CardContent className="py-8 text-center text-sm text-muted-foreground">{statsError}</CardContent>
              </Card>
            ) : (
              <div className="grid gap-4 sm:grid-cols-3">
                <MetricCard icon={Activity} label="CPU" value={stats ? `${stats.cpuPercent.toFixed(1)}%` : "—"} />
                <MetricCard
                  icon={KeyRound}
                  label="Memory"
                  value={stats ? `${formatBytes(stats.memoryUsageBytes)} / ${formatBytes(stats.memoryLimitBytes)}` : "—"}
                />
                <MetricCard icon={DatabaseBackup} label="Status" value={db.status} />
              </div>
            )}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Resource Limits</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-3">
                <MetricCard icon={HardDriveIcon} label="Storage" value={formatBytes(db.storageLimitBytes)} />
                <MetricCard icon={CpuIcon} label="CPU limit" value={db.cpuLimit ? `${db.cpuLimit} cores` : "—"} />
                <MetricCard icon={MemoryIcon} label="Memory limit" value={formatBytes(db.memoryLimitBytes)} />
              </CardContent>
            </Card>
          </div>
        )}

        {tab === "backups" && (
          <div className="space-y-6">
            {/* Scheduled backups */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <CalendarClock className="size-4 text-muted-foreground" /> Scheduled Backups
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">Enable automatic backups</p>
                    <p className="text-xs text-muted-foreground">The agent snapshots the database on a cron schedule and keeps only the newest backups.</p>
                  </div>
                  <Switch
                    checked={scheduleEnabled}
                    onChange={(v) => {
                      setScheduleEnabled(v);
                      if (v && !data?.database.backupSchedule?.enabled) void saveSchedule();
                    }}
                    ariaLabel="Enable scheduled backups"
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <p className="text-xs text-muted-foreground">Cron expression</p>
                    <Input
                      value={scheduleCron}
                      onChange={(e) => setScheduleCron(e.target.value)}
                      placeholder="0 2 * * *"
                      className="h-[42px] font-mono"
                      disabled={!scheduleEnabled}
                    />
                    <p className="text-[11px] text-muted-foreground">minute hour day month weekday — e.g. <code className="font-mono">0 2 * * *</code> daily at 02:00, <code className="font-mono">*/30 * * * *</code> every 30 min.</p>
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-xs text-muted-foreground">Keep backups</p>
                    <Input
                      type="number"
                      min={1}
                      max={365}
                      value={scheduleRetention}
                      onChange={(e) => setScheduleRetention(Math.max(1, Math.min(365, Number(e.target.value) || 7)))}
                      className="h-[42px]"
                      disabled={!scheduleEnabled}
                    />
                    <p className="text-[11px] text-muted-foreground">Older successful backups are deleted automatically (from the server and disk).</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">
                    {scheduleEnabled && data?.database.backupSchedule?.nextRunAt
                      ? <>Next run: <span className="font-medium text-foreground">{formatTime(data.database.backupSchedule.nextRunAt)}</span></>
                      : scheduleEnabled
                        ? "Next run will be computed after saving."
                        : "Scheduled backups are disabled."}
                  </p>
                  <Button size="sm" onClick={saveSchedule} disabled={scheduleSaving || !scheduleEnabled}>
                    {scheduleSaving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} Save schedule
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Backup history */}
            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <DatabaseBackup className="size-4 text-muted-foreground" /> Backups
                </CardTitle>
                <div className="flex items-center gap-3">
                  <Link to="/backups" className="text-xs text-primary hover:underline">
                    All backups <ExternalLink className="inline size-3" />
                  </Link>
                  <Button size="sm" variant="outline" onClick={() => setUploadOpen(true)} title="Upload a dump to this database">
                    <Upload className="size-3.5" /> Upload
                  </Button>
                  <Button size="sm" variant="outline" onClick={backup} disabled={backingUp || !canRun}>
                    {backingUp ? <Loader2 className="size-3.5 animate-spin" /> : <DatabaseBackup className="size-3.5" />} New Backup
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-1">
                {backups.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No backups yet — create one to snapshot the database.</p>}
                {backups.map((b) => (
                  <div key={b.id} className="flex items-center justify-between rounded-xl px-3 py-2.5 row-hover">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{b.id.slice(-12)}</p>
                      <p className="text-[11px] text-muted-foreground">{formatBytes(b.sizeBytes)} · {timeAgo(b.createdAt)}</p>
                    </div>
                  <div className="flex items-center gap-2">
                    {b.status === "SUCCESS" && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => download(b)} title="Download">
                          <Download className="size-3.5" />
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => restore(b)}>
                          Restore
                        </Button>
                      </>
                    )}
                    <StatusBadge status={b.status} />
                  </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        )}

        {tab === "advanced" && (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Image</span><span className="max-w-[60%] truncate font-medium">{db.image}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Host port</span><span className="font-medium">{db.port}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Internal port</span><span className="font-medium">{db.internalPort}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Storage</span><span className="font-medium">{formatBytes(db.storageLimitBytes)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Volume</span><span className="max-w-[60%] truncate font-medium">{db.volumeName ?? "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Memory limit</span><span className="font-medium">{formatBytes(db.memoryLimitBytes)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">CPU limit</span><span className="font-medium">{db.cpuLimit ? `${db.cpuLimit} cores` : "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Max connections</span><span className="font-medium">{db.maxConnections ?? "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Created</span><span className="font-medium">{timeAgo(db.createdAt)}</span></div>
              </CardContent>
            </Card>

            <Card className="border-destructive/30">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm text-destructive">
                  <Trash2 className="size-4" /> Danger Zone
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Delete database</p>
                  <p className="text-xs text-muted-foreground">Removes the container from the server. The persistent volume is kept unless destroyed.</p>
                </div>
                <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
                  <Trash2 className="size-4" /> Delete
                </Button>
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      {/* Exec terminal */}
      <Modal isOpen={execOpen} onClose={() => setExecOpen(false)} width="640px" maxWidth="640px">
        <div className="p-5">
          <h2 className="text-base font-semibold">Open Terminal</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">Run a command inside the {containerName} container.</p>
          <div className="mt-4 flex gap-2">
            <input
              value={execCmd}
              onChange={(e) => setExecCmd(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runExec()}
              placeholder="e.g. mysql -u root -p"
              className="h-[42px] flex-1 rounded-lg border border-input bg-muted/40 px-3 font-mono text-sm focus:border-ring/70 focus:outline-none focus:ring-2 focus:ring-ring/15"
            />
            <Button onClick={runExec} disabled={execBusy || !execCmd.trim()}>
              {execBusy ? <Loader2 className="size-4 animate-spin" /> : <Terminal className="size-4" />} Run
            </Button>
          </div>
          {execOut && (
            <pre className="nexus-terminal mt-4 max-h-[320px] overflow-auto rounded-xl bg-black/85 p-4 text-zinc-100">{execOut}</pre>
          )}
        </div>
      </Modal>

      {/* Upload backup modal */}
      <Modal isOpen={uploadOpen} onClose={() => setUploadOpen(false)} width="460px" maxWidth="460px">
        <div className="p-6">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <UploadCloud className="size-4" /> Upload backup
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Stream a dump file (.dump / .sql) to the agent host for <span className="font-medium text-foreground">{db.name}</span>. It will be available to restore.
          </p>
          <div className="mt-4 space-y-1.5">
            <Label>File</Label>
            <Input
              type="file"
              accept=".dump,.sql,.gz"
              onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
              className="h-auto cursor-pointer py-1.5"
            />
            <p className="text-[11px] text-muted-foreground">The file is streamed chunk-by-chunk to the server running this database.</p>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setUploadOpen(false)}>Cancel</Button>
            <Button onClick={uploadBackup} disabled={uploading || !uploadFile}>
              {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} Upload
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={remove}
        loading={deleting}
        title="Delete database"
        description="The database container will be removed from the server."
        resourceName={db.name}
        confirmLabel="Delete database"
      />
    </div>
  );
}

/* ── small presentational helpers ─────────────────────────────── */

function SecretField({
  label,
  value,
  secret = false,
  shown = false,
  mono = false,
  onToggle,
  onCopy,
  copyValue,
}: {
  label: string;
  value: string;
  secret?: boolean;
  shown?: boolean;
  mono?: boolean;
  onToggle?: () => void;
  onCopy?: () => void;
  copyValue?: string;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex h-[42px] items-center justify-between gap-2 rounded-lg border border-input bg-muted/40 px-3">
        <span className={cn("min-w-0 truncate text-sm text-foreground", mono && "font-mono text-[13px]")}>
          {secret && !shown ? "••••••••••••" : value}
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          {secret && onToggle && (
            <button onClick={onToggle} className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground" title={shown ? "Hide" : "Show"}>
              {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          )}
          {onCopy && (
            <button onClick={onCopy} className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground" title="Copy">
              <Copy className="size-3.5" />
            </button>
          )}
        </span>
      </div>
      {copyValue && <p className="sr-only">{copyValue}</p>}
    </div>
  );
}

function MetricCard({ icon: Icon, label, value }: { icon: ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/60 p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </div>
      <p className="mt-2 truncate text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/* ── Container Console (terminal) ─────────────────────────────── */

function DbContainerConsole({ db, containerName }: { db: Database; containerName: string }) {
  const { toast } = useToast();
  const id = db.id;
  const consoleRef = useRef<HTMLDivElement>(null);
  const [cmd, setCmd] = useState("");
  const [execBusy, setExecBusy] = useState(false);
  const running = db.status === "RUNNING";

  const logsQ = useQuery({
    queryKey: ["database-console-logs", id],
    queryFn: () => get<{ logs: string }>(`/databases/${id}/logs?tail=200`),
    enabled: running,
    refetchInterval: running ? 5000 : false,
    retry: false,
  });

  useEffect(() => {
    if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [logsQ.data?.logs]);

  const runExec = async () => {
    const parts = cmd.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return;
    setExecBusy(true);
    try {
      await post<{ output: string; exitCode: number }>(`/databases/${id}/exec`, { cmd: parts });
      toast("success", "Command sent", parts.join(" "));
      setTimeout(() => void logsQ.refetch(), 600);
    } catch (err) {
      toast("error", "Command failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setExecBusy(false);
      setCmd("");
    }
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-row items-center justify-between border-b border-border/50 bg-muted/30 py-2.5">
        <CardTitle className="flex items-center gap-2 text-[13px] font-medium">
          <Terminal className="size-3.5 text-muted-foreground" /> Container Console
        </CardTitle>
        <span className="text-[11px] text-muted-foreground">{running ? "live · 5s" : "container not running"}</span>
      </CardHeader>
      <CardContent className="p-0">
        <div ref={consoleRef} className="h-[420px] overflow-auto bg-black/85 p-4 font-mono text-[11.5px] leading-relaxed">
          {logsQ.isLoading && <p className="py-8 text-center text-sm text-zinc-500">Loading logs…</p>}
          {!logsQ.isLoading && logsQ.error && (
            <p className="py-8 text-center text-sm text-zinc-500">{(logsQ.error as Error).message}</p>
          )}
          {!logsQ.isLoading && !logsQ.error && (logsQ.data?.logs || "").trim().length === 0 && (
            <p className="py-8 text-center text-sm text-zinc-500">
              {running ? "No output yet — send a command or wait for the container to produce logs." : `Start the ${containerName} container to see its console.`}
            </p>
          )}
          <pre className="whitespace-pre-wrap break-all text-zinc-100">{logsQ.data?.logs ?? ""}</pre>
        </div>
        <div className="flex items-center gap-2 border-t border-border/50 bg-muted/30 px-3 py-2.5">
          <span className="select-none font-mono text-sm font-semibold text-primary">&gt;&gt;</span>
          <input
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runExec()}
            placeholder="Type a command… e.g. psql -U root -d postgres"
            disabled={!running || execBusy}
            className="h-9 flex-1 bg-transparent font-mono text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none disabled:opacity-50"
          />
          <Button size="sm" onClick={runExec} disabled={!running || execBusy || !cmd.trim()}>
            {execBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Terminal className="size-3.5" />} Send
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ── Database Browser (phpMyAdmin-style) ──────────────────────── */

interface DbObjects {
  databases: string[];
  tables: { name: string; size?: string }[];
  views: string[];
  indexes: string[];
  procedures: string[];
  sequences: string[];
  triggers: string[];
  events: string[];
  roles: string[];
  version?: string;
  message?: string;
}

interface DbTableInfo {
  columns: { name: string; type: string; nullable: boolean; key: string; defaultValue?: string | null }[];
  constraints: { name: string; type: string; definition?: string }[];
  foreignKeys: { name: string; columns: string; references: string }[];
  triggers: { name: string; event: string; timing: string }[];
  indexes: { name: string; columns: string; unique: boolean }[];
  message?: string;
}

/** Guess a column kind from its SQL type for the grid header badge. */
function colKind(type: string): "num" | "str" | "other" {
  const t = type.toLowerCase();
  if (/int|num|float|double|dec|money|real|serial|bytea|bool/i.test(t)) return "num";
  if (/char|text|str|json|uuid|date|time|enum|set|xml|blob|binary/i.test(t)) return "str";
  return "other";
}

const colKindIcon: Record<string, string> = { num: "123", str: "A-Z", other: "💾" };

function DbBrowser({ db }: { db: Database }) {
  const { toast } = useToast();
  const id = db.id;
  const [objects, setObjects] = useState<DbObjects | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(new Set());
  const [expandedCat, setExpandedCat] = useState<Set<string>>(new Set(["tables"]));
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableInfo, setTableInfo] = useState<DbTableInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [rows, setRows] = useState<{ columns: string[]; rows: string[][] } | null>(null);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [dataTab, setDataTab] = useState<"data" | "properties" | "diagram">("data");
  const [structTab, setStructTab] = useState<"columns" | "constraints" | "fks" | "triggers" | "indexes">("columns");
  const quote = (v: string) => '"' + v.replace(/"/g, "") + '"';

  const loadObjects = async () => {
    setLoading(true);
    try {
      const res = await get<DbObjects>(`/databases/${id}/objects`);
      setObjects(res);
      setMsg(res.message ?? null);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed to load database objects");
      setObjects(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadObjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const toggle = (set: Set<string>, key: string): Set<string> => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  const selectTable = async (name: string) => {
    setSelectedTable(name);
    setDataTab("data");
    setStructTab("columns");
    setRows(null);
    setRowsError(null);
    setInfoLoading(true);
    try {
      const [infoRes] = await Promise.all([
        get<DbTableInfo>(`/databases/${id}/table-info?table=${encodeURIComponent(name)}`),
        loadRows(name, ""),
      ]);
      setTableInfo(infoRes);
    } catch (err) {
      toast("error", "Failed to load table", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setInfoLoading(false);
    }
  };

  const loadRows = async (name: string, where: string) => {
    setRowsLoading(true);
    setRowsError(null);
    try {
      const sql = `SELECT * FROM ${quote(name)}${where.trim() ? ` WHERE ${where.trim()}` : ""} LIMIT 100;`;
      const res = await post<{ columns: string[]; rows: string[][]; truncated: boolean; message?: string }>(`/databases/${id}/query`, { sql });
      setRows({ columns: res.columns, rows: res.rows });
    } catch (err) {
      setRowsError(err instanceof Error ? err.message : "Query failed");
      setRows(null);
    } finally {
      setRowsLoading(false);
    }
  };

  const runFilter = () => {
    if (!selectedTable) return;
    void loadRows(selectedTable, filter);
  };

  const currentDb = objects?.databases?.find((d) => d === (db.dbName ?? db.name)) ?? objects?.databases?.[0] ?? "";
  const allTables = objects?.tables ?? [];
  const counts: Record<string, number> = {
    views: objects?.views?.length ?? 0,
    indexes: objects?.indexes?.length ?? 0,
    procedures: objects?.procedures?.length ?? 0,
    sequences: objects?.sequences?.length ?? 0,
    triggers: objects?.triggers?.length ?? 0,
    events: objects?.events?.length ?? 0,
  };

  const TreeRow = ({
    label, count, depth, expanded, hasChildren, onClick, active = false, icon,
  }: {
    label: string; count?: number; depth: number; expanded?: boolean; hasChildren?: boolean;
    onClick: () => void; active?: boolean; icon?: React.ReactNode;
  }) => (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors",
        active ? "bg-primary/10 text-primary" : "text-foreground/85 hover:bg-muted/60",
      )}
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      {hasChildren ? (
        expanded ? <ChevronDown className="size-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
      ) : (
        <span className="w-3 shrink-0" />
      )}
      {icon ?? <Table2 className="size-3.5 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && <span className="shrink-0 text-[10.5px] text-muted-foreground">{count}</span>}
    </button>
  );

  const renderTableRows = () => (
    <div className="space-y-0.5">
      {allTables.map((t) => (
        <button
          key={t.name}
          onClick={() => void selectTable(t.name)}
          className={cn(
            "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12.5px] transition-colors",
            selectedTable === t.name ? "bg-primary/10 text-primary" : "text-foreground/85 hover:bg-muted/60",
          )}
          style={{ paddingLeft: 8 + 3 * 14 }}
        >
          <span className="w-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t.name}</span>
          {t.size && <span className="shrink-0 text-[10.5px] text-muted-foreground">{t.size}</span>}
        </button>
      ))}
      {allTables.length === 0 && <p className="px-2 py-1 text-[11.5px] text-muted-foreground">No tables</p>}
    </div>
  );

  const renderCatRows = (key: string, items: string[]) => (
    <div className="space-y-0.5">
      {items.map((n) => (
        <div key={n} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-muted-foreground" style={{ paddingLeft: 8 + 3 * 14 }}>
          <span className="min-w-0 flex-1 truncate">{n}</span>
        </div>
      ))}
      {items.length === 0 && <p className="px-2 py-1 text-[11.5px] text-muted-foreground">None</p>}
    </div>
  );

  const sidebarItems = [
    { key: "views", label: "Views", count: counts.views, items: objects?.views ?? [] },
    { key: "indexes", label: "Índices", count: counts.indexes, items: objects?.indexes ?? [] },
    { key: "procedures", label: "Procedures", count: counts.procedures, items: objects?.procedures ?? [] },
    { key: "sequences", label: "Sequências", count: counts.sequences, items: objects?.sequences ?? [] },
    { key: "triggers", label: "Triggers", count: counts.triggers, items: objects?.triggers ?? [] },
    { key: "events", label: "Eventos", count: counts.events, items: objects?.events ?? [] },
  ];

  const colTypeOf = (name: string): string => tableInfo?.columns.find((c) => c.name === name)?.type ?? "";

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      {/* ── Sidebar tree ── */}
      <Card className="h-fit lg:max-h-[calc(100vh-220px)] lg:overflow-auto">
        <CardHeader className="border-b border-border/50">
          <div className="flex items-center gap-2">
            <DatabaseIcon className="size-4 text-primary" />
            <div className="min-w-0">
              <p className="truncate text-[12px] font-semibold">selected DB: <span className="font-mono text-primary">{currentDb || "—"}</span></p>
              <p className="text-[11px] text-muted-foreground">{objects?.version ? `🐘 ${objects.version}` : db.type}</p>
            </div>
          </div>
          <Button size="sm" variant="ghost" className="absolute right-3 top-3" onClick={() => void loadObjects()} disabled={loading} title="Reload objects">
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
        </CardHeader>
        <CardContent className="space-y-2 p-3">
          {loading && <Skeleton className="h-40" />}
          {!loading && msg && !objects && <p className="py-2 text-xs text-muted-foreground">{msg}</p>}
          {!loading && objects && (
            <>
              {/* Databases */}
              <p className="flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <ChevronDown className="size-3" /> Bancos de dados
              </p>
              <div className="space-y-0.5">
                {objects.databases.map((d) => {
                  const isCurrent = d === currentDb;
                  const expanded = expandedDbs.has(d);
                  return (
                    <div key={d}>
                      <TreeRow
                        label={d}
                        depth={1}
                        hasChildren={isCurrent}
                        expanded={expanded}
                        active={isCurrent}
                        onClick={() => isCurrent && setExpandedDbs((s) => toggle(s, d))}
                        icon={isCurrent ? <DatabaseIcon className="size-3.5 shrink-0 text-primary" /> : <DatabaseIcon className="size-3.5 shrink-0 text-muted-foreground" />}
                      />
                      {isCurrent && expanded && (
                        <div className="mt-0.5 space-y-0.5">
                          {/* Tabelas */}
                          <div>
                            <TreeRow
                              label="Tabelas"
                              count={allTables.length}
                              depth={2}
                              hasChildren
                              expanded={expandedCat.has("tables")}
                              onClick={() => setExpandedCat((s) => toggle(s, "tables"))}
                              icon={<ListTree className="size-3.5 shrink-0 text-muted-foreground" />}
                            />
                            {expandedCat.has("tables") && renderTableRows()}
                          </div>
                          {/* other categories */}
                          {sidebarItems.map((it) => (
                            <div key={it.key}>
                              <TreeRow
                                label={it.label}
                                count={it.count}
                                depth={2}
                                hasChildren={it.items.length > 0}
                                expanded={expandedCat.has(it.key)}
                                onClick={() => setExpandedCat((s) => toggle(s, it.key))}
                                icon={<Zap className="size-3.5 shrink-0 text-muted-foreground" />}
                              />
                              {expandedCat.has(it.key) && renderCatRows(it.key, it.items)}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Bottom sections */}
              <div className="mt-2 border-t border-border/50 pt-2">
                <TreeRow label="Usuários" count={objects.roles.length} depth={1} onClick={() => toast("info", "Usuários", `${objects.roles.join(", ") || "none"}`)} icon={<Users className="size-3.5 shrink-0 text-muted-foreground" />} />
                <TreeRow label="Administrar" depth={1} onClick={() => toast("info", "Administrar", "Database management actions are available on the General tab.")} icon={<Wrench className="size-3.5 shrink-0 text-muted-foreground" />} />
                <TreeRow label="Informações do sistema" depth={1} onClick={() => toast("info", "Informações", `${objects.version ?? db.type} · ${db.image}`)} icon={<Info className="size-3.5 shrink-0 text-muted-foreground" />} />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Main panel ── */}
      <div className="space-y-4">
        {/* View tabs */}
        <div className="flex items-center gap-1 overflow-x-auto border-b border-border/60 scrollbar-hide">
          {[
            { key: "data" as const, label: "💾 Dados", icon: Table2 },
            { key: "properties" as const, label: "📋 Propriedades", icon: Columns3 },
            { key: "diagram" as const, label: "📐 Diagrama", icon: Link2 },
          ].map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setDataTab(key)}
              className={cn(
                "relative inline-flex shrink-0 items-center gap-2 whitespace-nowrap px-4 py-2.5 text-sm font-medium transition-colors",
                dataTab === key ? "text-foreground" : "text-muted-foreground hover:text-foreground/70",
              )}
            >
              <Icon className="size-4" />
              {label}
              {dataTab === key && <span className="absolute bottom-0 start-4 end-4 h-0.5 rounded-full bg-primary" />}
            </button>
          ))}
        </div>

        {!selectedTable ? (
          <Card>
            <CardContent className="py-16 text-center">
              <FolderTree className="mx-auto size-10 text-muted-foreground/50" />
              <p className="mt-3 text-sm font-medium">Select a table</p>
              <p className="mx-auto mt-1 max-w-sm text-[13px] text-muted-foreground">
                Pick a table from the tree on the left to browse its data, filter with SQL and inspect its structure.
              </p>
            </CardContent>
          </Card>
        ) : dataTab === "properties" ? (
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="text-sm">Propriedades de <span className="font-mono">{selectedTable}</span></CardTitle>
              {infoLoading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            </CardHeader>
            <CardContent>
              {tableInfo && (
                <div className="overflow-auto rounded-xl border border-border/60">
                  <table className="w-full border-collapse text-[12px]">
                    <thead className="bg-muted/80">
                      <tr>
                        <th className="border-b border-border/60 px-3 py-2 text-left font-medium">Column</th>
                        <th className="border-b border-border/60 px-3 py-2 text-left font-medium">Type</th>
                        <th className="border-b border-border/60 px-3 py-2 text-left font-medium">Nullable</th>
                        <th className="border-b border-border/60 px-3 py-2 text-left font-medium">Key</th>
                        <th className="border-b border-border/60 px-3 py-2 text-left font-medium">Default</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tableInfo.columns.map((c) => (
                        <tr key={c.name} className="hover:bg-muted/40">
                          <td className="border-b border-border/30 px-3 py-1.5 font-mono">{c.name}</td>
                          <td className="border-b border-border/30 px-3 py-1.5 text-muted-foreground">{c.type}</td>
                          <td className="border-b border-border/30 px-3 py-1.5">{c.nullable ? "YES" : "NO"}</td>
                          <td className="border-b border-border/30 px-3 py-1.5 font-mono text-primary">{c.key || "—"}</td>
                          <td className="max-w-[220px] truncate border-b border-border/30 px-3 py-1.5 font-mono text-muted-foreground">{c.defaultValue ?? "NULL"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        ) : dataTab === "diagram" ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Diagrama de <span className="font-mono">{selectedTable}</span></CardTitle>
            </CardHeader>
            <CardContent>
              {tableInfo && tableInfo.foreignKeys.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">This table has no foreign keys.</p>
              ) : (
                <div className="space-y-2">
                  {tableInfo?.foreignKeys.map((fk) => (
                    <div key={fk.name} className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 px-3 py-2.5 font-mono text-[12.5px]">
                      <Link2 className="size-3.5 text-primary" />
                      <span className="text-primary">{fk.name}</span>
                      <span className="text-muted-foreground">({fk.columns})</span>
                      <span className="text-muted-foreground">→</span>
                      <span>{fk.references}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ) : (
          /* Data view */
          <>
            {/* SQL filter */}
            <Card>
              <CardContent className="flex items-center gap-2 p-3">
                <Search className="size-4 shrink-0 text-muted-foreground" />
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && runFilter()}
                  placeholder="Insira uma expressão SQL para filtrar os resultados (use Ctrl+Espaço)"
                  spellCheck={false}
                  className="h-9 flex-1 bg-transparent font-mono text-[12.5px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
                />
                <Button size="sm" onClick={runFilter} disabled={rowsLoading}>
                  {rowsLoading ? <Loader2 className="size-3.5 animate-spin" /> : <Filter className="size-3.5" />} Filtrar
                </Button>
              </CardContent>
            </Card>

            {rowsError && (
              <Card className="border-destructive/40">
                <CardContent className="py-4">
                  <pre className="whitespace-pre-wrap font-mono text-[13px] text-destructive">{rowsError}</pre>
                </CardContent>
              </Card>
            )}

            {/* Data grid */}
            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Table2 className="size-4 text-muted-foreground" /> <span className="font-mono">{selectedTable}</span>
                </CardTitle>
                {rowsLoading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
              </CardHeader>
              <CardContent>
                {rows && rows.columns.length > 0 ? (
                  <div className="max-h-[420px] overflow-auto rounded-xl border border-border/60">
                    <table className="w-full border-collapse text-[12px]">
                      <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                        <tr>
                          <th className="border-b border-border/60 px-3 py-2 text-left font-medium">#</th>
                          {rows.columns.map((c) => {
                            const kind = colKind(colTypeOf(c));
                            return (
                              <th key={c} className="border-b border-border/60 px-3 py-2 text-left font-medium">
                                <span className="mr-1.5 text-[10px] text-muted-foreground">{colKindIcon[kind]}</span>
                                {c}
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.rows.map((row, i) => (
                          <tr key={i} className="hover:bg-muted/40">
                            <td className="border-b border-border/30 px-3 py-1.5 text-muted-foreground tabular-nums">{i + 1}</td>
                            {row.map((cell, j) => (
                              <td key={j} className="max-w-[280px] truncate border-b border-border/30 px-3 py-1.5 font-mono">
                                {cell === "" ? <span className="text-muted-foreground/60">[NULL]</span> : cell}
                              </td>
                            ))}
                          </tr>
                        ))}
                        {rows.rows.length === 0 && (
                          <tr>
                            <td colSpan={rows.columns.length + 1} className="px-3 py-4 text-center text-muted-foreground">0 rows</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    {rowsError ? "Query failed — check the error above." : "Loading rows…"}
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Structure tabs */}
            <Card>
              <div className="flex items-center gap-1 overflow-x-auto border-b border-border/60 px-2 scrollbar-hide">
                {[
                  { key: "columns" as const, label: "Colunas", icon: Columns3 },
                  { key: "constraints" as const, label: "Constraints", icon: ListTree },
                  { key: "fks" as const, label: "Chaves Estrangeiras", icon: Link2 },
                  { key: "triggers" as const, label: "Triggers", icon: Zap },
                  { key: "indexes" as const, label: "Índices", icon: Search },
                ].map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    onClick={() => setStructTab(key)}
                    className={cn(
                      "relative inline-flex shrink-0 items-center gap-2 whitespace-nowrap px-3.5 py-2.5 text-[12.5px] font-medium transition-colors",
                      structTab === key ? "text-foreground" : "text-muted-foreground hover:text-foreground/70",
                    )}
                  >
                    <Icon className="size-3.5" />
                    {label}
                    {structTab === key && <span className="absolute bottom-0 start-3 end-3 h-0.5 rounded-full bg-primary" />}
                  </button>
                ))}
              </div>
              <CardContent className="p-0">
                {infoLoading ? (
                  <div className="p-8 text-center"><Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" /></div>
                ) : structTab === "columns" ? (
                  <div className="overflow-auto">
                    <table className="w-full border-collapse text-[12px]">
                      <thead className="bg-muted/80">
                        <tr>
                          <th className="border-b border-border/60 px-3 py-2 text-left font-medium">Name</th>
                          <th className="border-b border-border/60 px-3 py-2 text-left font-medium">Type</th>
                          <th className="border-b border-border/60 px-3 py-2 text-left font-medium">Nullable</th>
                          <th className="border-b border-border/60 px-3 py-2 text-left font-medium">Key</th>
                          <th className="border-b border-border/60 px-3 py-2 text-left font-medium">Default</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(tableInfo?.columns ?? []).map((c) => (
                          <tr key={c.name} className="hover:bg-muted/40">
                            <td className="border-b border-border/30 px-3 py-1.5 font-mono">{c.name}</td>
                            <td className="border-b border-border/30 px-3 py-1.5 text-muted-foreground">{c.type}</td>
                            <td className="border-b border-border/30 px-3 py-1.5">{c.nullable ? "YES" : "NO"}</td>
                            <td className="border-b border-border/30 px-3 py-1.5 font-mono text-primary">{c.key || "—"}</td>
                            <td className="max-w-[220px] truncate border-b border-border/30 px-3 py-1.5 font-mono text-muted-foreground">{c.defaultValue ?? "NULL"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : structTab === "constraints" ? (
                  <div className="overflow-auto">
                    <table className="w-full border-collapse text-[12px]">
                      <thead className="bg-muted/80">
                        <tr>
                          <th className="border-b border-border/60 px-3 py-2 text-left font-medium">Name</th>
                          <th className="border-b border-border/60 px-3 py-2 text-left font-medium">Type</th>
                          <th className="border-b border-border/60 px-3 py-2 text-left font-medium">Definition</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(tableInfo?.constraints ?? []).map((c) => (
                          <tr key={c.name} className="hover:bg-muted/40">
                            <td className="border-b border-border/30 px-3 py-1.5 font-mono">{c.name}</td>
                            <td className="border-b border-border/30 px-3 py-1.5"><span className="rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">{c.type}</span></td>
                            <td className="max-w-[420px] truncate border-b border-border/30 px-3 py-1.5 font-mono text-muted-foreground">{c.definition ?? "—"}</td>
                          </tr>
                        ))}
                        {(tableInfo?.constraints ?? []).length === 0 && <tr><td colSpan={3} className="px-3 py-4 text-center text-muted-foreground">No constraints</td></tr>}
                      </tbody>
                    </table>
                  </div>
                ) : structTab === "fks" ? (
                  <div className="overflow-auto">
                    <table className="w-full border-collapse text-[12px]">
                      <thead className="bg-muted/80">
                        <tr>
                          <th className="border-b border-border/60 px-3 py-2 text-left font-medium">Name</th>
                          <th className="border-b border-border/60 px-3 py-2 text-left font-medium">Columns</th>
                          <th className="border-b border-border/60 px-3 py-2 text-left font-medium">References</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(tableInfo?.foreignKeys ?? []).map((fk) => (
                          <tr key={fk.name} className="hover:bg-muted/40">
                            <td className="border-b border-border/30 px-3 py-1.5 font-mono text-primary">{fk.name}</td>
                            <td className="border-b border-border/30 px-3 py-1.5 font-mono">{fk.columns}</td>
                            <td className="border-b border-border/30 px-3 py-1.5 font-mono text-muted-foreground">{fk.references}</td>
                          </tr>
                        ))}
                        {(tableInfo?.foreignKeys ?? []).length === 0 && <tr><td colSpan={3} className="px-3 py-4 text-center text-muted-foreground">No foreign keys</td></tr>}
                      </tbody>
                    </table>
                  </div>
                ) : structTab === "triggers" ? (
                  <div className="overflow-auto">
                    <table className="w-full border-collapse text-[12px]">
                      <thead className="bg-muted/80">
                        <tr>
                          <th className="border-b border-border/60 px-3 py-2 text-left font-medium">Name</th>
                          <th className="border-b border-border/60 px-3 py-2 text-left font-medium">Event</th>
                          <th className="border-b border-border/60 px-3 py-2 text-left font-medium">Timing</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(tableInfo?.triggers ?? []).map((t) => (
                          <tr key={t.name} className="hover:bg-muted/40">
                            <td className="border-b border-border/30 px-3 py-1.5 font-mono">{t.name}</td>
                            <td className="border-b border-border/30 px-3 py-1.5"><span className="rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">{t.event}</span></td>
                            <td className="max-w-[420px] truncate border-b border-border/30 px-3 py-1.5 font-mono text-muted-foreground">{t.timing}</td>
                          </tr>
                        ))}
                        {(tableInfo?.triggers ?? []).length === 0 && <tr><td colSpan={3} className="px-3 py-4 text-center text-muted-foreground">No triggers</td></tr>}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="overflow-auto">
                    <table className="w-full border-collapse text-[12px]">
                      <thead className="bg-muted/80">
                        <tr>
                          <th className="border-b border-border/60 px-3 py-2 text-left font-medium">Name</th>
                          <th className="border-b border-border/60 px-3 py-2 text-left font-medium">Columns</th>
                          <th className="border-b border-border/60 px-3 py-2 text-left font-medium">Unique</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(tableInfo?.indexes ?? []).map((ix) => (
                          <tr key={ix.name} className="hover:bg-muted/40">
                            <td className="border-b border-border/30 px-3 py-1.5 font-mono">{ix.name}</td>
                            <td className="border-b border-border/30 px-3 py-1.5 font-mono">{ix.columns}</td>
                            <td className="border-b border-border/30 px-3 py-1.5">{ix.unique ? "YES" : "NO"}</td>
                          </tr>
                        ))}
                        {(tableInfo?.indexes ?? []).length === 0 && <tr><td colSpan={3} className="px-3 py-4 text-center text-muted-foreground">No indexes</td></tr>}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
