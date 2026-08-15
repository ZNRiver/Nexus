import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { CalendarClock, DatabaseBackup, Download, HardDrive, Loader2, RotateCcw, Trash2, Upload } from "lucide-react";
import { get, post, del, downloadBackup } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { PageHeader } from "@/components/page-header";
import { TableSkeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CustomSelect } from "@/components/ui/custom-select";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/toast";
import { useQueryClient } from "@tanstack/react-query";
import { formatBytes, timeAgo } from "@/lib/format";
import type { Backup, Database, ApplicationWithExtras } from "@nexus/types";

type BackupRow = Backup & { resourceName?: string; resourceId?: string };

export function BackupsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: dbs } = useQuery({ queryKey: ["databases"], queryFn: () => get<{ items: Database[] }>("/databases", { limit: "200" }) });
  const { data: apps } = useQuery({ queryKey: ["applications"], queryFn: () => get<{ items: ApplicationWithExtras[] }>("/applications", { limit: "200" }) });
  const { data, isLoading } = useQuery({
    queryKey: ["all-backups"],
    queryFn: async () => {
      const items: BackupRow[] = [];
      for (const db of dbs?.items ?? []) {
        const res = await get<{ items: Backup[] }>(`/databases/${db.id}/backups`).catch(() => ({ items: [] }));
        for (const b of res.items) items.push({ ...b, resourceName: db.name, resourceId: db.id });
      }
      for (const app of apps?.items ?? []) {
        const res = await get<{ items: Backup[] }>(`/applications/${app.id}/backups`).catch(() => ({ items: [] }));
        for (const b of res.items) items.push({ ...b, resourceName: app.name, resourceId: app.id });
      }
      return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    enabled: !!dbs?.items.length || !!apps?.items.length,
    refetchInterval: 8000,
  });

  // Upload state
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadKind, setUploadKind] = useState<"DATABASE" | "VOLUME">("DATABASE");
  const [uploadTarget, setUploadTarget] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const restore = async (b: Backup) => {
    try {
      await post(`/backups/${b.id}/restore`);
      toast("success", "Restore started", `Restoring backup ${b.id.slice(-8)}`);
      queryClient.invalidateQueries({ queryKey: ["all-backups"] });
    } catch (err) {
      toast("error", "Restore failed", err instanceof Error ? err.message : "Unknown error");
    }
  };

  const download = async (b: BackupRow) => {
    try {
      await downloadBackup(b.id, `${b.resourceName ?? "backup"}-${b.id.slice(-8)}${b.type === "VOLUME" ? ".tar.gz" : ".dump"}`);
      toast("success", "Download started", b.id.slice(-8));
    } catch (err) {
      toast("error", "Download failed", err instanceof Error ? err.message : "Unknown error");
    }
  };

  const remove = async (b: Backup) => {
    try {
      await del(`/backups/${b.id}`);
      toast("success", "Backup deleted", b.id.slice(-8));
      queryClient.invalidateQueries({ queryKey: ["all-backups"] });
    } catch (err) {
      toast("error", "Delete failed", err instanceof Error ? err.message : "Unknown error");
    }
  };

  const upload = async () => {
    if (!uploadFile || !uploadTarget) return;
    setUploading(true);
    try {
      const target = uploadKind === "DATABASE"
        ? (dbs?.items ?? []).find((d) => d.id === uploadTarget)
        : (apps?.items ?? []).find((a) => a.id === uploadTarget);
      if (!target) throw new Error("Target resource not found");
      const serverId = target.serverId;
      const query = new URLSearchParams({ serverId, kind: uploadKind, [uploadKind === "DATABASE" ? "databaseId" : "applicationId"]: uploadTarget });
      const res = await fetch(`/api/v1/backups/upload?${query}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/octet-stream" },
        body: uploadFile,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ?? `Upload failed (${res.status})`);
      toast("success", "Backup uploaded", `${uploadFile.name} (${formatBytes(uploadFile.size)})`);
      setUploadOpen(false);
      setUploadFile(null);
      setUploadTarget("");
      if (fileRef.current) fileRef.current.value = "";
      queryClient.invalidateQueries({ queryKey: ["all-backups"] });
    } catch (err) {
      toast("error", "Upload failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setUploading(false);
    }
  };

  const uploadTargets = uploadKind === "DATABASE" ? (dbs?.items ?? []) : (apps?.items ?? []);
  const uploadTargetOptions = uploadTargets
    .filter((t) => uploadKind === "VOLUME" ? t.volumeName : true)
    .map((t) => ({ value: t.id, label: t.name, description: t.serverId }));

  const scheduledDbs = (dbs?.items ?? []).filter((d) => d.backupSchedule?.enabled);
  const scheduledApps = (apps?.items ?? []).filter((a) => a.backupSchedule?.enabled);
  const detailPath = (b: BackupRow) => (b.type === "VOLUME" ? `/applications/${b.resourceId}` : `/databases/${b.resourceId}`);

  return (
    <div className="p-6">
      <PageHeader
        title="Backups"
        description="Database snapshots and application volume snapshots created through the agent on each server."
        actions={
          <Button onClick={() => setUploadOpen(true)}>
            <Upload className="size-4" /> Upload backup
          </Button>
        }
      />

      {(scheduledDbs.length > 0 || scheduledApps.length > 0) && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CalendarClock className="size-3.5" /> Scheduled:
          </span>
          {scheduledDbs.map((d) => (
            <Link
              key={d.id}
              to={`/databases/${d.id}`}
              className="rounded-full border border-border/70 bg-muted/40 px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted"
              title={`${d.backupSchedule?.cron} · keep ${d.backupSchedule?.retention}`}
            >
              <DatabaseBackup className="mr-1 inline size-3" />{d.name} <span className="font-mono text-muted-foreground">{d.backupSchedule?.cron}</span>
            </Link>
          ))}
          {scheduledApps.map((a) => (
            <Link
              key={a.id}
              to={`/applications/${a.id}`}
              className="rounded-full border border-border/70 bg-muted/40 px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted"
              title={`${a.backupSchedule?.cron} · keep ${a.backupSchedule?.retention}`}
            >
              <HardDrive className="mr-1 inline size-3" />{a.name} <span className="font-mono text-muted-foreground">{a.backupSchedule?.cron}</span>
            </Link>
          ))}
        </div>
      )}

      {isLoading ? (
        <TableSkeleton rows={6} cols={5} />
      ) : !data?.length ? (
        <EmptyState
          icon={<DatabaseBackup className="size-5" />}
          title="No backups"
          description="Create a database or an application with a persistent volume, then trigger a backup from its detail page. Snapshots appear here."
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="divide-y divide-border/50">
            {data.map((b) => (
              <div key={b.id} className="flex items-center gap-4 px-5 py-3.5">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  {b.type === "VOLUME" ? <HardDrive className="size-4" /> : <DatabaseBackup className="size-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">
                    <Link to={detailPath(b)} className="hover:underline">
                      {b.resourceName ?? b.databaseId ?? b.applicationId}
                    </Link>
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {b.type === "VOLUME" ? "VOLUME" : "DATABASE"} · {formatBytes(b.sizeBytes)} · {timeAgo(b.createdAt)}
                    {b.path ? ` · ${b.path}` : ""}
                  </p>
                </div>
                {b.status === "SUCCESS" && (
                  <div className="flex shrink-0 gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => download(b)} title="Download">
                      <Download className="size-4" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => restore(b)} title="Restore">
                      <RotateCcw className="size-4" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(b)} title="Delete" className="text-muted-foreground hover:text-destructive">
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                )}
                <StatusBadge status={b.status} className="shrink-0" />
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Upload modal */}
      <Modal isOpen={uploadOpen} onClose={() => setUploadOpen(false)} width="480px" maxWidth="480px">
        <div className="p-6">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Upload className="size-4" /> Upload backup
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Stream a dump (.dump) or volume snapshot (.tar.gz) to the agent host so it can be restored there.
          </p>
          <div className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <Label className="text-[13px]">Backup type</Label>
              <CustomSelect
                value={uploadKind}
                options={[
                  { value: "DATABASE", label: "Database", description: ".dump from pg_dump / mysqldump / etc." },
                  { value: "VOLUME", label: "Application volume", description: ".tar.gz snapshot of a container volume" },
                ]}
                onChange={(v) => {
                  setUploadKind(v as "DATABASE" | "VOLUME");
                  setUploadTarget("");
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[13px]">{uploadKind === "DATABASE" ? "Target database" : "Target application"}</Label>
              <CustomSelect
                value={uploadTarget}
                options={uploadTargetOptions}
                onChange={setUploadTarget}
                placeholder={uploadKind === "DATABASE" ? "Select a database" : "Select an application with a volume"}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[13px]">File</Label>
              <Input
                ref={fileRef}
                type="file"
                accept={uploadKind === "DATABASE" ? ".dump,.sql,.gz" : ".tar.gz,.tgz,.gz"}
                onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
                className="h-auto cursor-pointer py-1.5"
              />
              <p className="text-[11px] text-muted-foreground">
                The file is streamed chunk-by-chunk to the server running the {uploadKind === "DATABASE" ? "database" : "application"}.
              </p>
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setUploadOpen(false)}>Cancel</Button>
            <Button onClick={upload} disabled={uploading || !uploadFile || !uploadTarget}>
              {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} Upload
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
