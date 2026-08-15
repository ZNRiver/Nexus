import { useEffect, useMemo, useRef, useState } from "react";
import type { Ref } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Globe, Rocket, RefreshCw, Wrench, Play, Terminal, Eye, EyeOff, KeyRound, Trash2, Plus, Loader2,
  RotateCcw, Square, Settings as SettingsIcon, CircleHelp, Check, DatabaseBackup, HardDrive, Download, CalendarClock, Save, Upload, UploadCloud,
} from "lucide-react";
import { get, post, put, del, patch, downloadBackup } from "@/lib/api";
import { subscribeDashboard } from "@/lib/ws";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CustomSelect } from "@/components/ui/custom-select";
import { Switch } from "@/components/ui/Switch";
import { Modal } from "@/components/ui/Modal";
import { Tabs, type TabDef } from "@/components/ui/Tabs";
import { StatusBadge } from "@/components/status-badge";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Skeleton } from "@/components/skeleton";
import { useToast } from "@/components/toast";
import { durationMs, timeAgo, shortId, formatBytes, formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ApplicationWithExtras, Backup, Deployment, DeploymentLogEntry, Domain, EnvironmentVariable } from "@nexus/types";

type TabKey = "general" | "environment" | "domains" | "deployments" | "logs" | "backups" | "settings";

const TABS: TabDef<TabKey>[] = [
  { key: "general", label: "General", icon: Globe },
  { key: "environment", label: "Environment", icon: KeyRound },
  { key: "domains", label: "Domains", icon: Globe },
  { key: "deployments", label: "Deployments", icon: RotateCcw },
  { key: "logs", label: "Logs", icon: Terminal },
  { key: "backups", label: "Backups", icon: DatabaseBackup },
  { key: "settings", label: "Settings", icon: SettingsIcon },
];

const BUILD_TYPES = [
  { key: "DOCKERFILE", label: "Dockerfile" },
  { key: "COMPOSE", label: "Docker Compose" },
  { key: "RAILPACK", label: "Railpack", disabled: true },
  { key: "NIXPACKS", label: "Nixpacks", disabled: true },
  { key: "HEROKU", label: "Heroku Buildpacks", disabled: true },
  { key: "PAKETO", label: "Paketo Buildpacks", disabled: true },
  { key: "STATIC", label: "Static", disabled: true },
];

const PROVIDERS = ["Github", "Gitlab", "Bitbucket", "Gitea", "Docker", "Git", "Drop"] as const;

type Provider = (typeof PROVIDERS)[number];

function detectProvider(repo: string): Provider {
  const u = repo.toLowerCase();
  if (u.includes("github")) return "Github";
  if (u.includes("gitlab")) return "Gitlab";
  if (u.includes("bitbucket")) return "Bitbucket";
  if (u.includes("gitea")) return "Gitea";
  if (u.startsWith("docker://") || u.includes("docker.io")) return "Docker";
  return "Git";
}

export function ApplicationDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TabKey>("general");
  const [deployOpen, setDeployOpen] = useState(false);
  const [branch, setBranch] = useState("");
  const [deploying, setDeploying] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<Deployment | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [cleaningCache, setCleaningCache] = useState(false);
  const [envText, setEnvText] = useState("");
  const [envInit, setEnvInit] = useState(false);
  const [savingEnv, setSavingEnv] = useState(false);
  const [envSecretKeys, setEnvSecretKeys] = useState<Record<string, boolean>>({});
  const [revealedEnv, setRevealedEnv] = useState<Record<string, string>>({});
  const [envMasked, setEnvMasked] = useState(true);
  const envEditorRef = useRef<HTMLTextAreaElement>(null);
  const envGutterRef = useRef<HTMLDivElement>(null);
  const [domainHost, setDomainHost] = useState("");
  const [domainSsl, setDomainSsl] = useState(false);
  const [settings, setSettings] = useState<{ name: string; branch: string; port: string; restartPolicy: string; description: string } | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [provider, setProvider] = useState<{ repository: string; branch: string; buildPath: string; buildContext: string } | null>(null);
  const [savingProvider, setSavingProvider] = useState(false);
  const [execOpen, setExecOpen] = useState(false);
  const [execCmd, setExecCmd] = useState("");
  const [execOut, setExecOut] = useState("");
  const [execBusy, setExecBusy] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleCron, setScheduleCron] = useState("0 2 * * *");
  const [scheduleRetention, setScheduleRetention] = useState(7);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const logsRef = useRef<HTMLDivElement>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["application-detail", id],
    queryFn: () =>
      get<{
        application: ApplicationWithExtras;
        deployments: Deployment[];
        environment: EnvironmentVariable[];
        domains: Domain[];
        server?: { id: string; name: string } | null;
      }>(`/applications/${id}`),
    refetchInterval: 10000,
  });

  const backupsQ = useQuery({
    queryKey: ["application-backups", id],
    queryFn: () => get<{ items: Backup[] }>(`/applications/${id}/backups`),
    enabled: tab === "backups",
    refetchInterval: tab === "backups" ? 8000 : false,
  });
  const backups = backupsQ.data;

  const { data: liveLogs } = useQuery({
    queryKey: ["application-live-logs", id],
    queryFn: () => get<{ logs: string }>(`/applications/${id}/logs`),
    enabled: tab === "logs" && !!data?.application.currentContainerId,
    refetchInterval: 5000,
  });

  const latestDeployment = data?.deployments?.[0];

  // Deployment logs for the active/failed deployment.
  const { data: depLogs } = useQuery({
    queryKey: ["deployment-logs", latestDeployment?.id],
    queryFn: () => get<{ logs: DeploymentLogEntry[] }>(`/deployments/${latestDeployment!.id}/logs`),
    enabled: !!latestDeployment?.id && tab === "logs",
    refetchInterval: latestDeployment && ["QUEUED", "CLONING", "BUILDING", "PUSHING", "DEPLOYING", "STARTING", "HEALTH_CHECK", "WAITING_FOR_SERVER"].includes(latestDeployment.status) ? 3000 : false,
  });

  useEffect(() => {
    if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [depLogs?.logs.length, liveLogs?.logs.length]);

  // Real-time updates.
  useEffect(() => {
    const unsub = subscribeDashboard((event) => {
      if (event.type === "deployment.status" && event.deployment.applicationId === id) {
        queryClient.invalidateQueries({ queryKey: ["application-detail", id] });
      }
      if (event.type === "deployment.log" && latestDeployment?.id === event.deploymentId) {
        queryClient.invalidateQueries({ queryKey: ["deployment-logs", latestDeployment.id] });
      }
      if (event.type === "container.status" || event.type === "database.status" || event.type === "server.status") {
        queryClient.invalidateQueries({ queryKey: ["application-detail", id] });
      }
    });
    return unsub;
  }, [id, queryClient, latestDeployment?.id]);

  const app = data?.application;
  const server = data?.server;
  const branchValue = branch || app?.branch || "main";

  // Initialize settings + provider forms once data is available.
  useEffect(() => {
    if (data?.application && !settings) {
      const a = data.application;
      setSettings({ name: a.name, branch: a.branch, port: a.port ? String(a.port) : "", restartPolicy: a.restartPolicy, description: a.description ?? "" });
      setProvider({ repository: a.repository, branch: a.branch, buildPath: a.deploymentMethod === "DOCKERFILE" ? a.dockerfilePath : a.composePath, buildContext: a.buildContext });
    }
  }, [data, settings]);

  const deploy = async () => {
    setDeploying(true);
    try {
      const res = await post<{ deploymentId: string }>(`/applications/${id}/deploy`, { branch: branchValue });
      toast("success", "Deployment queued", branchValue);
      setDeployOpen(false);
      setTab("logs");
      queryClient.invalidateQueries({ queryKey: ["application-detail", id] });
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["deployment-logs", res.deploymentId] }), 500);
    } catch (err) {
      toast("error", "Deploy failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setDeploying(false);
    }
  };

  const rollback = async () => {
    if (!rollbackTarget) return;
    setRollingBack(true);
    try {
      const res = await post<{ deploymentId: string }>(`/applications/${id}/rollback`, { deploymentId: rollbackTarget.id });
      toast("success", "Rollback queued", `Restoring ${rollbackTarget.id.slice(-8)}`);
      setRollbackTarget(null);
      setTab("logs");
      queryClient.invalidateQueries({ queryKey: ["application-detail", id] });
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["deployment-logs", res.deploymentId] }), 500);
    } catch (err) {
      toast("error", "Rollback failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setRollingBack(false);
    }
  };

  const runAction = async (action: "restart" | "stop" | "start" | "rebuild", label: string) => {
    setActionBusy(true);
    try {
      const res = await post<{ deploymentId?: string }>(`/applications/${id}/${action}`);
      toast("success", `${label} requested`, app?.name);
      queryClient.invalidateQueries({ queryKey: ["application-detail", id] });
      if (res.deploymentId) setTimeout(() => queryClient.invalidateQueries({ queryKey: ["deployment-logs", res.deploymentId] }), 500);
    } catch (err) {
      toast("error", "Action failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setActionBusy(false);
    }
  };

  const cleanCache = async () => {
    setCleaningCache(true);
    try {
      await post(`/applications/${id}/clean-cache`);
      toast("success", "Cache cleared", app?.name);
    } catch (err) {
      toast("error", "Cache clear failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setCleaningCache(false);
    }
  };

  const toggleAutodeploy = async (v: boolean) => {
    try {
      await patch(`/applications/${id}`, { autodeploy: v });
      queryClient.invalidateQueries({ queryKey: ["application-detail", id] });
      toast("success", v ? "Autodeploy enabled" : "Autodeploy disabled");
    } catch (err) {
      toast("error", "Update failed", err instanceof Error ? err.message : "Unknown error");
    }
  };

  const saveProvider = async () => {
    if (!provider) return;
    setSavingProvider(true);
    try {
      await patch(`/applications/${id}`, {
        repository: provider.repository.trim(),
        branch: provider.branch.trim(),
        dockerfilePath: provider.buildPath.trim() || "Dockerfile",
        buildContext: provider.buildContext.trim() || ".",
      });
      queryClient.invalidateQueries({ queryKey: ["application-detail", id] });
      toast("success", "Provider settings saved");
    } catch (err) {
      toast("error", "Save failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSavingProvider(false);
    }
  };

  const selectProvider = async (p: Provider) => {
    try {
      await patch(`/applications/${id}`, { provider: p });
      queryClient.invalidateQueries({ queryKey: ["application-detail", id] });
      toast("success", "Provider updated", p);
    } catch (err) {
      toast("error", "Update failed", err instanceof Error ? err.message : "Unknown error");
    }
  };

  const selectBuildMethod = async (m: "DOCKERFILE" | "COMPOSE") => {
    try {
      await patch(`/applications/${id}`, { deploymentMethod: m });
      queryClient.invalidateQueries({ queryKey: ["application-detail", id] });
      toast("success", "Build type updated", m === "DOCKERFILE" ? "Dockerfile" : "Docker Compose");
    } catch (err) {
      toast("error", "Update failed", err instanceof Error ? err.message : "Unknown error");
    }
  };

  /** Build the editor text (KEY=VALUE per line, secrets masked) from the API list. */
  const buildEnvText = (envs: EnvironmentVariable[], reveal: Record<string, string>): string =>
    envs
      .map((e) => {
        const value = e.isSecret && envMasked && !reveal[e.id] ? "••••••••••••" : (reveal[e.id] ?? e.valueMasked);
        return `${e.key}=${value}`;
      })
      .join("\n");

  // Initialize the editor once the env list arrives.
  useEffect(() => {
    if (data?.environment && !envInit) {
      setEnvText(buildEnvText(data.environment, revealedEnv));
      setEnvSecretKeys(Object.fromEntries(data.environment.map((e) => [e.key, e.isSecret])));
      setEnvInit(true);
    }
  }, [data, envInit]);

  const revealEnv = async (env: EnvironmentVariable) => {
    try {
      const res = await post<{ value: string }>(`/applications/${id}/environment/${env.id}/reveal`);
      setRevealedEnv((r) => {
        const next = { ...r, [env.id]: res.value };
        // Refresh the editor with the real value for this line.
        setEnvText(buildEnvText(data?.environment ?? [], next));
        return next;
      });
    } catch (err) {
      toast("error", "Reveal failed", err instanceof Error ? err.message : "Unknown error");
    }
  };

  const toggleEnvMasked = async () => {
    if (envMasked && data?.environment) {
      await Promise.all(data.environment.filter((e) => e.isSecret && !revealedEnv[e.id]).map((e) => revealEnv(e).catch(() => {})));
      setEnvMasked(false);
    } else {
      setEnvMasked(true);
      setEnvText(buildEnvText(data?.environment ?? [], revealedEnv));
    }
  };

  /** Save the whole editor back to the backend (diff → upsert/delete). */
  const saveEnv = async () => {
    const variables = envText
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return null;
        const eq = trimmed.indexOf("=");
        if (eq <= 0) return null;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
        return { key, value, isSecret: !!envSecretKeys[key] };
      })
      .filter((v): v is { key: string; value: string; isSecret: boolean } => v !== null);
    setSavingEnv(true);
    try {
      await put(`/applications/${id}/environment`, { variables });
      queryClient.invalidateQueries({ queryKey: ["application-detail", id] });
      toast("success", "Environment saved", `${variables.length} variables`);
    } catch (err) {
      toast("error", "Save failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSavingEnv(false);
    }
  };

  const addDomain = async () => {
    if (!domainHost.trim()) return;
    try {
      await post(`/applications/${id}/domains`, { hostname: domainHost.trim(), sslEnabled: domainSsl });
      queryClient.invalidateQueries({ queryKey: ["application-detail", id] });
      setDomainHost("");
      setDomainSsl(false);
      toast("success", "Domain added", domainHost.trim());
    } catch (err) {
      toast("error", "Failed", err instanceof Error ? err.message : "Unknown error");
    }
  };

  const removeDomain = async (d: Domain) => {
    try {
      await del(`/applications/${id}/domains/${d.id}`);
      queryClient.invalidateQueries({ queryKey: ["application-detail", id] });
      toast("success", "Domain removed", d.hostname);
    } catch (err) {
      toast("error", "Delete failed", err instanceof Error ? err.message : "Unknown error");
    }
  };

  const saveSettings = async () => {
    if (!settings) return;
    setSavingSettings(true);
    try {
      await patch(`/applications/${id}`, {
        name: settings.name,
        description: settings.description || undefined,
        branch: settings.branch,
        port: settings.port ? parseInt(settings.port, 10) : undefined,
        restartPolicy: settings.restartPolicy,
      });
      queryClient.invalidateQueries({ queryKey: ["application-detail", id] });
      toast("success", "Application updated", settings.name);
    } catch (err) {
      toast("error", "Update failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSavingSettings(false);
    }
  };

  const removeApp = async () => {
    setDeleting(true);
    try {
      await del(`/applications/${id}`);
      toast("success", "Application deleted", app?.name);
      navigate("/applications");
    } catch (err) {
      toast("error", "Delete failed", err instanceof Error ? err.message : "Unknown error");
      setDeleting(false);
    }
  };

  const createBackup = async () => {
    setBackingUp(true);
    try {
      await post(`/applications/${id}/backup`);
      toast("success", "Backup started", "The agent is snapshotting the persistent volume");
      queryClient.invalidateQueries({ queryKey: ["application-backups", id] });
    } catch (err) {
      toast("error", "Backup failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBackingUp(false);
    }
  };

  const restoreBackup = async (b: Backup) => {
    try {
      await post(`/backups/${b.id}/restore`);
      toast("success", "Restore started", `Restoring ${b.id.slice(-8)}`);
      queryClient.invalidateQueries({ queryKey: ["application-backups", id] });
    } catch (err) {
      toast("error", "Restore failed", err instanceof Error ? err.message : "Unknown error");
    }
  };

  const download = async (b: Backup) => {
    try {
      await downloadBackup(b.id, `${app?.name ?? "app"}-${b.id.slice(-8)}.tar.gz`);
      toast("success", "Download started", b.id.slice(-8));
    } catch (err) {
      toast("error", "Download failed", err instanceof Error ? err.message : "Unknown error");
    }
  };

  // Sync schedule form with the loaded application (once).
  useEffect(() => {
    if (data?.application.backupSchedule) {
      const s = data.application.backupSchedule;
      setScheduleEnabled(s.enabled);
      setScheduleCron(s.cron || "0 2 * * *");
      setScheduleRetention(s.retention || 7);
    }
  }, [data?.application.id]);

  const uploadBackup = async () => {
    if (!uploadFile) return;
    setUploading(true);
    try {
      const query = new URLSearchParams({ serverId: app?.serverId ?? "", kind: "VOLUME", applicationId: id });
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
      queryClient.invalidateQueries({ queryKey: ["application-backups", id] });
    } catch (err) {
      toast("error", "Upload failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setUploading(false);
    }
  };

  const saveSchedule = async () => {
    setScheduleSaving(true);
    try {
      await put(`/applications/${id}/backup-schedule`, {
        enabled: scheduleEnabled,
        cron: scheduleCron.trim() || "0 2 * * *",
        retention: scheduleRetention,
      });
      toast("success", scheduleEnabled ? "Scheduled backups enabled" : "Scheduled backups disabled");
      queryClient.invalidateQueries({ queryKey: ["application-detail", id] });
    } catch (err) {
      toast("error", "Failed to save schedule", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setScheduleSaving(false);
    }
  };

  const runExec = async () => {
    const cmd = execCmd.trim().split(/\s+/).filter(Boolean);
    if (cmd.length === 0) return;
    setExecBusy(true);
    try {
      const res = await post<{ output: string; exitCode: number }>(`/applications/${id}/exec`, { cmd });
      setExecOut(res.output || `(exit ${res.exitCode})`);
    } catch (err) {
      setExecOut(err instanceof Error ? `✗ ${err.message}` : "✗ Unknown error");
    } finally {
      setExecBusy(false);
    }
  };

  const active = ["QUEUED", "CLONING", "BUILDING", "PUSHING", "DEPLOYING", "STARTING", "HEALTH_CHECK", "WAITING_FOR_SERVER"].includes(latestDeployment?.status ?? "");
  const logs = useMemo(() => {
    const entries = depLogs?.logs ?? [];
    const lines = liveLogs?.logs && liveLogs.logs.trim() ? liveLogs.logs.split("\n") : [];
    return { entries, liveLines: lines };
  }, [depLogs, liveLogs]);

  if (isLoading || !data || !app) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-10" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  const containerName = `nexus-${app.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "app"}-${id.slice(-8)}`;
  const providerName: Provider = (app.provider as Provider | null | undefined) ?? detectProvider(provider?.repository ?? app.repository);

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-muted-foreground">Application</p>
          <div className="mt-1 flex items-center gap-3">
            <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight">
              <span className="flex size-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Globe className="size-4" />
              </span>
              {app.name}
            </h1>
            <StatusBadge status={app.status} />
            {active && <StatusBadge status={latestDeployment?.status ?? ""} />}
          </div>
          <p className="mt-1 font-mono text-[13px] text-muted-foreground">{containerName}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {app.deploymentMethod} · {providerName} · {app.branch} · {server?.name ?? app.serverId}
          </p>
        </div>
        <div className="flex gap-2">
          {app.currentContainerId && (
            <>
              <Button variant="outline" size="sm" onClick={() => runAction("restart", "Reload")} disabled={actionBusy || app.status !== "RUNNING"}>
                <RefreshCw className="size-4" /> Reload
              </Button>
              <Button variant="outline" size="sm" onClick={() => runAction("stop", "Stop")} disabled={actionBusy || app.status !== "RUNNING"}>
                <Square className="size-4" /> Stop
              </Button>
            </>
          )}
          <Button size="sm" onClick={() => setDeployOpen(true)} disabled={app.status === "DEPLOYING" || active}>
            <Rocket className="size-4" /> Deploy
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="mt-6">
        <Tabs
          tabs={TABS.map((t) =>
            t.key === "environment" ? { ...t, count: data.environment.length } : t.key === "domains" ? { ...t, count: data.domains.length } : t.key === "deployments" ? { ...t, count: data.deployments.length } : t,
          )}
          value={tab}
          onChange={setTab}
        />
      </div>

      <div className="mt-6">
        {tab === "general" && (
          <div className="space-y-6">
            {/* Deploy Settings */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Deploy Settings</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => setDeployOpen(true)} disabled={app.status === "DEPLOYING" || active}>
                    <Rocket className="size-4" /> Deploy
                  </Button>
                  <Button variant="outline" onClick={() => runAction("restart", "Reload")} disabled={actionBusy || !app.currentContainerId || app.status !== "RUNNING"}>
                    {actionBusy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Reload
                  </Button>
                  <Button variant="outline" onClick={() => runAction("rebuild", "Rebuild")} disabled={actionBusy || active}>
                    <Wrench className="size-4" /> Rebuild
                  </Button>
                  <Button variant="outline" onClick={() => runAction("start", "Start")} disabled={actionBusy || !app.currentContainerId || app.status === "RUNNING"}>
                    <Play className="size-4" /> Start
                  </Button>
                  <Button variant="outline" onClick={() => setExecOpen(true)} disabled={!app.currentContainerId || app.status !== "RUNNING"}>
                    <Terminal className="size-4" /> Open Terminal
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-x-8 gap-y-3 border-t border-border/50 pt-4">
                  <label className="flex items-center gap-2 text-[13px]">
                    <Switch size="sm" checked={!!app.autodeploy} onChange={toggleAutodeploy} /> Autodeploy
                  </label>
                  <label className="flex items-center gap-2 text-[13px]">
                    <Switch size="sm" checked={cleaningCache} onChange={(v) => v && cleanCache()} /> Clean Cache
                  </label>
                  <span className="text-[11px] text-muted-foreground">Clean Cache runs <code className="rounded bg-muted px-1 font-mono">php artisan cache:clear</code> inside the container.</span>
                </div>
              </CardContent>
            </Card>

            {/* Provider */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Provider</CardTitle>
                <p className="text-xs text-muted-foreground">Select the source of your code</p>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  {PROVIDERS.map((p) => {
                    const activeProvider = p === providerName;
                    return (
                      <button
                        key={p}
                        type="button"
                        onClick={() => selectProvider(p)}
                        title={app.provider === p ? "Saved provider" : `Set provider to ${p}`}
                        className={cn(
                          "inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                          activeProvider
                            ? "border-primary/50 bg-primary/10 text-primary"
                            : "border-border/70 text-muted-foreground hover:border-border hover:bg-foreground/[0.05] hover:text-foreground",
                        )}
                      >
                        {activeProvider && <Check className="size-3" />}
                        {p}
                      </button>
                    );
                  })}
                </div>
                {provider && (
                  <>
                    <div className="space-y-1.5">
                      <Label className="text-[13px]">Repository</Label>
                      <Input className="font-mono" value={provider.repository} onChange={(e) => setProvider({ ...provider, repository: e.target.value })} placeholder="https://github.com/org/repo.git" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-[13px]">Branch</Label>
                        <Input value={provider.branch} onChange={(e) => setProvider({ ...provider, branch: e.target.value })} placeholder="main" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-[13px]">Build Path</Label>
                        <Input className="font-mono" value={provider.buildPath} onChange={(e) => setProvider({ ...provider, buildPath: e.target.value })} placeholder="Dockerfile" />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-1.5">
                        <Label className="text-[13px]">Trigger Type</Label>
                        <CircleHelp className="size-3.5 text-muted-foreground/60" />
                      </div>
                      <CustomSelect
                        value={app.triggerType ?? "MANUAL"}
                        options={[
                          { value: "MANUAL", label: "Manual", description: "Deploy only from the button" },
                          { value: "ON_PUSH", label: "On Push", description: "Deploy when the repository receives a push" },
                          { value: "SCHEDULE", label: "Schedule", description: "Deploy on a cron schedule (not configured yet)" },
                        ]}
                        onChange={(v) =>
                          patch(`/applications/${id}`, { triggerType: v })
                            .then(() => {
                              queryClient.invalidateQueries({ queryKey: ["application-detail", id] });
                              toast("success", "Trigger type updated", v);
                            })
                            .catch((err) => toast("error", "Update failed", err instanceof Error ? err.message : "Unknown error"))
                        }
                      />
                    </div>
                    <div className="flex justify-end">
                      <Button onClick={saveProvider} disabled={savingProvider}>
                        {savingProvider ? <Loader2 className="size-4 animate-spin" /> : null} Save provider
                      </Button>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {/* Build Type */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Build Type</CardTitle>
                <p className="text-xs text-muted-foreground">Select the way of building your code</p>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="overflow-hidden rounded-lg border border-border">
                  {BUILD_TYPES.map((b, i) => {
                    const currentMethod: "DOCKERFILE" | "COMPOSE" = app.deploymentMethod === "DOCKERFILE" ? "DOCKERFILE" : "COMPOSE";
                    const selected = b.key === currentMethod;
                    const clickable = !b.disabled;
                    return (
                      <button
                        key={b.key}
                        type="button"
                        onClick={() => clickable && selectBuildMethod(b.key as "DOCKERFILE" | "COMPOSE")}
                        disabled={!clickable}
                        title={clickable ? `Use ${b.label} to build` : "Coming soon"}
                        className={cn(
                          "flex w-full items-center gap-2.5 px-3 py-1.5 text-[13px] transition-colors",
                          i > 0 && "border-t border-border/60",
                          clickable ? "cursor-pointer hover:bg-foreground/[0.04]" : "cursor-not-allowed",
                          selected ? "bg-primary/[0.06] text-foreground" : !clickable && "text-muted-foreground",
                        )}
                      >
                        <span
                          className={cn(
                            "flex size-3.5 shrink-0 items-center justify-center rounded-full border",
                            selected ? "border-primary" : "border-border",
                          )}
                        >
                          {selected && <span className="size-1.5 rounded-full bg-primary" />}
                        </span>
                        <span className="flex-1 text-left">{b.label}</span>
                        {b.key === "RAILPACK" && <span className="rounded bg-primary/10 px-1 py-px text-[9px] font-medium text-primary">New</span>}
                        {b.disabled && <span className="text-[10px] text-muted-foreground/70">soon</span>}
                      </button>
                    );
                  })}
                </div>
                {provider && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-[13px]">Docker File</Label>
                        <Input className="font-mono" value={provider.buildPath} onChange={(e) => setProvider({ ...provider, buildPath: e.target.value })} placeholder="Dockerfile" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-[13px]">Docker Context Path</Label>
                        <Input className="font-mono" value={provider.buildContext} onChange={(e) => setProvider({ ...provider, buildContext: e.target.value })} placeholder="." />
                      </div>
                    </div>
                    <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <CircleHelp className="size-3.5" /> Docker build stage targeting is not implemented yet.
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {tab === "environment" && (
          <div className="space-y-6">
            <Card>
              <CardHeader className="flex-row items-start justify-between">
                <div>
                  <CardTitle className="text-sm">Environment Settings</CardTitle>
                  <p className="mt-0.5 text-xs text-muted-foreground">You can add environment variables to your resource. Edit the file below — one <code className="rounded bg-muted px-1 font-mono">KEY=VALUE</code> per line.</p>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => void toggleEnvMasked()} title={envMasked ? "Reveal secret values" : "Hide secret values"}>
                    {envMasked ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />} {envMasked ? "Reveal" : "Hide"}
                  </Button>
                  <Button size="sm" onClick={saveEnv} disabled={savingEnv}>
                    {savingEnv ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-3.5" />} Save
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="overflow-hidden rounded-xl border border-border/60">
                  <div className="flex">
                    {/* line-number gutter */}
                    <div
                      ref={envGutterRef}
                      className="select-none overflow-hidden border-r border-border/40 bg-muted/40 px-3 py-3 text-right font-mono text-[12px] leading-6 text-muted-foreground/50"
                      aria-hidden="true"
                    >
                      {envText.split("\n").map((_, i) => (
                        <div key={i}>{i + 1}</div>
                      ))}
                    </div>
                    <textarea
                      ref={envEditorRef}
                      value={envText}
                      onChange={(e) => setEnvText(e.target.value)}
                      onScroll={() => {
                        if (envGutterRef.current && envEditorRef.current) {
                          envGutterRef.current.scrollTop = envEditorRef.current.scrollTop;
                        }
                      }}
                      spellCheck={false}
                      placeholder="DATABASE_URL=postgres://user:pass@db:5432/app"
                      className="min-h-[240px] w-full flex-1 resize-y bg-muted/20 py-3 pr-3 font-mono text-[12px] leading-6 text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
                    />
                  </div>
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Lines starting with <code className="rounded bg-muted px-1 font-mono">#</code> are ignored. Secrets stay encrypted at rest and are shown as dots until you press Reveal — saving with dots keeps the stored value.
                </p>
              </CardContent>
            </Card>
          </div>
        )}

        {tab === "domains" && (
          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Globe className="size-4 text-muted-foreground" /> Domains
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {data.domains.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">No domains attached. Reverse-proxy routing is ready once a ProxyProvider is configured.</p>}
                {data.domains.map((d) => (
                  <div key={d.id} className="flex items-center justify-between rounded-xl px-3 py-2.5 row-hover">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{d.hostname}</p>
                      <p className="text-[11px] text-muted-foreground">{d.isPrimary ? "primary · " : ""}SSL {d.sslStatus.toLowerCase()}</p>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => removeDomain(d)} className="shrink-0 text-muted-foreground hover:text-destructive">
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card className="h-fit">
              <CardHeader>
                <CardTitle className="text-sm">Add domain</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5">
                  <Label>Hostname</Label>
                  <Input className="font-mono" value={domainHost} onChange={(e) => setDomainHost(e.target.value)} placeholder="api.example.com" onKeyDown={(e) => e.key === "Enter" && addDomain()} />
                </div>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch size="sm" checked={domainSsl} onChange={setDomainSsl} /> Enable SSL
                </label>
                <Button className="w-full" onClick={addDomain} disabled={!domainHost.trim()}>
                  <Plus className="size-4" /> Add
                </Button>
              </CardContent>
            </Card>
          </div>
        )}

        {tab === "deployments" && (
          <Card className="overflow-hidden">
            <div className="divide-y divide-border/50">
              {data.deployments.length === 0 && (
                <div className="p-10 text-center text-sm text-muted-foreground">No deployments yet.</div>
              )}
              {data.deployments.map((d) => (
                <div key={d.id} className="flex items-center gap-4 px-5 py-3.5 row-hover">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                    <Rocket className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">
                      {d.id.slice(-12)}
                      {d.rollbackFrom && <span className="ml-2 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-600 dark:text-amber-400">rollback</span>}
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {d.branch} {d.commit ? `· ${shortId(d.commit)}` : ""} · {d.image ?? "no image"} · {durationMs(d.durationMs)} · {timeAgo(d.createdAt)} · {d.triggeredByName ?? "system"}
                    </p>
                    {d.error && <p className="mt-0.5 truncate text-[11px] text-destructive">{d.error}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {d.status === "SUCCESS" && !active && d.id !== app.lastDeploymentId && (
                      <Button size="sm" variant="outline" onClick={() => setRollbackTarget(d)}>
                        <RotateCcw className="size-3.5" /> Rollback
                      </Button>
                    )}
                    <StatusBadge status={d.status} />
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {tab === "logs" && (
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Terminal className="size-4 text-muted-foreground" />
                {app.currentContainerId ? "Container logs (live)" : "Build logs"}
              </CardTitle>
              <span className="text-[11px] text-muted-foreground">{app.currentContainerId ? "refreshing every 5s" : `deployment ${latestDeployment?.id.slice(-8) ?? "—"}`}</span>
            </CardHeader>
            <CardContent>
              <LogView entries={logs.entries} liveLines={logs.liveLines} ref={logsRef} empty="No logs yet — deploy the application to see the build pipeline." />
            </CardContent>
          </Card>
        )}

        {tab === "backups" && (
          <div className="space-y-6">
            {/* Scheduled volume backups */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <CalendarClock className="size-4 text-muted-foreground" /> Scheduled Backups
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">Enable automatic volume backups</p>
                    <p className="text-xs text-muted-foreground">The agent snapshots the persistent volume on a cron schedule and keeps only the newest backups.</p>
                  </div>
                  <Switch
                    checked={scheduleEnabled}
                    onChange={(v) => {
                      setScheduleEnabled(v);
                      if (v && !data?.application.backupSchedule?.enabled) void saveSchedule();
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
                    <p className="text-[11px] text-muted-foreground">minute hour day month weekday — e.g. <code className="font-mono">0 2 * * *</code> daily at 02:00.</p>
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
                    {!app.volumeName
                      ? "Add a persistent volume to enable scheduled backups."
                      : scheduleEnabled && data?.application.backupSchedule?.nextRunAt
                        ? <>Next run: <span className="font-medium text-foreground">{formatTime(data.application.backupSchedule.nextRunAt)}</span></>
                        : scheduleEnabled
                          ? "Next run will be computed after saving."
                          : "Scheduled backups are disabled."}
                  </p>
                  <Button size="sm" onClick={saveSchedule} disabled={scheduleSaving || !scheduleEnabled || !app.volumeName}>
                    {scheduleSaving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} Save schedule
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Persistent volume */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <HardDrive className="size-4 text-muted-foreground" /> Persistent Volume
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  {app.volumeName ? (
                    <>
                      <p className="font-mono text-[13px]">{app.volumeName}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Mounted at {app.volumeMountPath ?? "—"} — snapshots capture this data.
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      This application has no persistent volume configured. Add a volume (and a mount path) to enable backups.
                    </p>
                  )}
                </div>
                {app.volumeName && (
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => setUploadOpen(true)} title="Upload a .tar.gz snapshot to this volume">
                      <Upload className="size-4" /> Upload
                    </Button>
                    <Button onClick={createBackup} disabled={backingUp}>
                      {backingUp ? <Loader2 className="size-4 animate-spin" /> : <DatabaseBackup className="size-4" />} New Backup
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Backup history */}
            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <DatabaseBackup className="size-4 text-muted-foreground" /> Volume Backups
                </CardTitle>
                <span className="text-[11px] text-muted-foreground">{backups?.items.length ?? 0} snapshots</span>
              </CardHeader>
              <CardContent className="space-y-1">
                {backupsQ.isLoading && <Skeleton className="h-16" />}
                {(backups?.items.length ?? 0) === 0 && !backupsQ.isLoading && (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No volume backups yet — {app.volumeName ? "create one to snapshot the persistent data." : "configure a persistent volume first."}
                  </p>
                )}
                {(backups?.items ?? []).map((b) => (
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
                          <Button size="sm" variant="outline" onClick={() => restoreBackup(b)}>
                            <RotateCcw className="size-3.5" /> Restore
                          </Button>
                        </>
                      )}
                      <StatusBadge status={b.status} />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <p className="text-[11px] text-muted-foreground">
              Restoring replaces the contents of the volume with the snapshot. The container is automatically stopped before the restore and started again afterwards, so no process writes to the volume while it is being replaced.
            </p>
          </div>
        )}

        {tab === "settings" && (
          <div className="max-w-2xl space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <SettingsIcon className="size-4 text-muted-foreground" /> Application settings
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {settings && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label>Name</Label>
                        <Input value={settings.name} onChange={(e) => setSettings({ ...settings, name: e.target.value })} />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Branch</Label>
                        <Input value={settings.branch} onChange={(e) => setSettings({ ...settings, branch: e.target.value })} />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label>Port</Label>
                        <Input type="number" value={settings.port} onChange={(e) => setSettings({ ...settings, port: e.target.value })} placeholder="3000" />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Restart policy</Label>
                        <CustomSelect
                          value={settings.restartPolicy}
                          options={[
                            { value: "no", label: "no" },
                            { value: "always", label: "always" },
                            { value: "on-failure", label: "on-failure" },
                            { value: "unless-stopped", label: "unless-stopped" },
                          ]}
                          onChange={(v) => setSettings({ ...settings, restartPolicy: v })}
                        />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Description</Label>
                      <Input value={settings.description} onChange={(e) => setSettings({ ...settings, description: e.target.value })} />
                    </div>
                    <div className="flex items-center gap-2">
                      <Button onClick={saveSettings} disabled={savingSettings}>
                        {savingSettings ? <Loader2 className="size-4 animate-spin" /> : null} Save changes
                      </Button>
                      <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
                        <Trash2 className="size-4" /> Delete application
                      </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Source (repository, Dockerfile, compose file, environment) is edited by redeploying. Deleting with <code className="rounded bg-muted px-1">?destroy=true</code> also removes the container and network.
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      {/* Deploy modal */}
      <Modal isOpen={deployOpen} onClose={() => setDeployOpen(false)} width="480px" maxWidth="480px">
        <div className="p-6">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Rocket className="size-4" /> Deploy {app.name}
          </h2>
          <div className="mt-4 space-y-3 rounded-xl border border-border/60 bg-muted/40 p-4 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Server</span><span className="font-medium">{server?.name ?? app.serverId}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Method</span><span className="font-medium">{app.deploymentMethod}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Repository</span><span className="max-w-[60%] truncate font-medium">{app.repository}</span></div>
          </div>
          <div className="mt-4 space-y-1.5">
            <Label>Branch</Label>
            <Input value={branchValue} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeployOpen(false)}>Cancel</Button>
            <Button onClick={deploy} disabled={deploying || !branchValue.trim()}>
              {deploying ? <Loader2 className="size-4 animate-spin" /> : <Rocket className="size-4" />} Deploy
            </Button>
          </div>
        </div>
      </Modal>

      {/* Rollback modal */}
      <Modal isOpen={!!rollbackTarget} onClose={() => setRollbackTarget(null)} width="440px" maxWidth="440px">
        <div className="p-6">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <RotateCcw className="size-4" /> Rollback to {rollbackTarget?.id.slice(-12)}
          </h2>
          <p className="mt-2 text-xs text-muted-foreground">
            {app.deploymentMethod === "DOCKERFILE" ? "The previous image will be used to redeploy the container." : "The compose stack will be restored from the corresponding commit."}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setRollbackTarget(null)}>Cancel</Button>
            <Button onClick={rollback} disabled={rollingBack}>
              {rollingBack ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />} Rollback
            </Button>
          </div>
        </div>
      </Modal>

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
              placeholder="e.g. php artisan migrate"
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
            <UploadCloud className="size-4" /> Upload volume backup
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Stream a .tar.gz snapshot to the agent host for <span className="font-medium text-foreground">{app.name}</span>. It will be available to restore into the volume.
          </p>
          <div className="mt-4 space-y-1.5">
            <Label>File</Label>
            <Input
              type="file"
              accept=".tar.gz,.tgz,.gz"
              onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
              className="h-auto cursor-pointer py-1.5"
            />
            <p className="text-[11px] text-muted-foreground">The file is streamed chunk-by-chunk to the server running this application.</p>
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
        onConfirm={removeApp}
        loading={deleting}
        title="Delete application"
        description="The application will be removed from NEXUS. Running containers are not destroyed."
        resourceName={app.name}
        confirmLabel="Delete application"
      />
    </div>
  );
}

const LogView = ({ entries, liveLines, ref, empty }: { entries: DeploymentLogEntry[]; liveLines: string[]; ref?: Ref<HTMLDivElement>; empty: string }) => {
  const all = [
    ...entries.map((e) => ({ stream: e.stream, text: e.message, ts: e.timestamp })),
    ...liveLines.map((line) => ({ stream: "stdout" as const, text: line, ts: "" })),
  ];
  if (all.length === 0) return <p className="py-10 text-center text-sm text-muted-foreground">{empty}</p>;
  return (
    <div ref={ref} className="max-h-[480px] overflow-auto rounded-xl bg-black/85 p-4 font-mono text-[11.5px] leading-relaxed">
      {all.map((l, i) => (
        <div key={i} className="flex gap-3">
          <span className="shrink-0 select-none text-zinc-500">{l.ts ? new Date(l.ts).toLocaleTimeString() : "•••••"}</span>
          <span className={l.stream === "stderr" ? "text-red-400" : l.stream === "system" ? "text-sky-300" : "text-zinc-100"}>{l.text}</span>
        </div>
      ))}
    </div>
  );
};
