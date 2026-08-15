import { useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Database as DbIcon, Plus, Loader2, CircleHelp } from "lucide-react";
import { DbLogo, DB_COLORS } from "@/components/db-logos";
import { get, post } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CustomSelect } from "@/components/ui/custom-select";
import { Modal } from "@/components/ui/Modal";
import { StatusBadge } from "@/components/status-badge";
import { PageHeader } from "@/components/page-header";
import { TableSkeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import { formatBytes, timeAgo } from "@/lib/format";
import type { Database, DatabaseType, Project, Server } from "@nexus/types";

const DB_TYPES: {
  key: DatabaseType;
  label: string;
  versions: string[];
  defaultPort: number;
}[] = [
  { key: "POSTGRESQL", label: "PostgreSQL", versions: ["17", "16", "15", "14"], defaultPort: 5432 },
  { key: "MONGODB", label: "MongoDB", versions: ["8", "7", "6"], defaultPort: 27017 },
  { key: "MARIADB", label: "MariaDB", versions: ["11", "10.11"], defaultPort: 3306 },
  { key: "MYSQL", label: "MySQL", versions: ["8.4", "8.0"], defaultPort: 3306 },
  { key: "REDIS", label: "Redis", versions: ["7", "6"], defaultPort: 6379 },
  { key: "INFLUXDB", label: "InfluxDB", versions: ["2.7", "2.6", "1.8"], defaultPort: 8086 },
];

const HELP: Record<string, string> = {
  server: "Where this database runs. The NEXUS Agent on that server creates and manages the container.",
  appName: "Optional project the database belongs to — groups it with your applications.",
  dbName: "Name of the database inside the engine (defaults to the resource name).",
};

export function DatabasesPage({ mode }: { mode?: string }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(mode === "new" || params.get("new") === "1");
  const [creating, setCreating] = useState(false);
  const modalContentRef = useRef<HTMLDivElement>(null);
  const [form, setForm] = useState({
    serverId: "",
    type: "POSTGRESQL" as DatabaseType,
    version: "",
    name: "",
    description: "",
    dbName: "",
    username: "",
    password: "",
    projectId: "",
  });

  const { data: servers } = useQuery({ queryKey: ["servers"], queryFn: () => get<{ items: Server[] }>("/servers") });
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => get<{ items: Project[] }>("/projects") });
  const { data: dbs, isLoading } = useQuery({ queryKey: ["databases"], queryFn: () => get<{ items: Database[] }>("/databases"), refetchInterval: 10000 });

  const typeInfo = DB_TYPES.find((t) => t.key === form.type)!;
  const serverOptions = (servers?.items ?? []).map((s) => ({ value: s.id, label: s.name, description: s.status }));
  const versionOptions = typeInfo.versions.map((v) => ({ value: v, label: v }));
  const projectOptions = [{ value: "", label: "No project" }, ...(projects?.items ?? []).map((p) => ({ value: p.id, label: p.name }))];
  const close = () => {
    if (creating) return;
    setOpen(false);
    setParams({}, { replace: true });
  };

  const pickType = (key: DatabaseType) => {
    const t = DB_TYPES.find((x) => x.key === key)!;
    setForm((f) => ({ ...f, type: key, version: t.versions[0] }));
    // Keep the panel visually frozen — reset scroll so collapsing/expanding fields never jump.
    modalContentRef.current?.scrollTo({ top: 0 });
  };

  const openModal = () => {
    setForm({ serverId: servers?.items[0]?.id ?? "", type: "POSTGRESQL", version: "17", name: "", description: "", dbName: "", username: "", password: "", projectId: "" });
    setOpen(true);
  };

  const create = async () => {
    setCreating(true);
    try {
      const res = await post<{ database: { id: string } }>("/databases", {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        serverId: form.serverId,
        type: form.type,
        version: form.version || typeInfo.versions[0],
        dbName: form.dbName.trim() || undefined,
        username: form.username.trim() || undefined,
        password: form.password || undefined,
        projectId: form.projectId || undefined,
      });
      toast("success", "Database created", form.name);
      navigate(`/databases/${res.database.id}`);
    } catch (err) {
      toast("error", "Creation failed", err instanceof Error ? err.message : "Unknown error");
      setCreating(false);
    }
  };

  const inputCls = "h-[42px] rounded-lg bg-muted/40 focus:border-ring/70 focus:ring-2 focus:ring-ring/15";

  return (
    <div className="p-6">
      <PageHeader
        title="Databases"
        description="Managed PostgreSQL, MySQL, MariaDB, Redis, MongoDB and InfluxDB running in containers."
        actions={
          <Button onClick={openModal}>
            <Plus className="size-4" /> New Database
          </Button>
        }
      />

      {isLoading ? (
        <TableSkeleton rows={6} cols={5} />
      ) : !dbs?.items.length ? (
        <EmptyState
          icon={<DbIcon className="size-5" />}
          title="No databases"
          description="Provision a managed database on any server. Storage is backed by a persistent volume."
          actionLabel="Create Database"
          onAction={openModal}
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="divide-y divide-border/50">
            {dbs.items.map((db) => (
              <Link key={db.id} to={`/databases/${db.id}`} className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-foreground/[0.05]">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
                  <DbLogo type={db.type} className={cn("size-5", DB_COLORS[db.type])} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-semibold">{db.name}</p>
                    <span className="hidden rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:inline">
                      {db.type}
                    </span>
                  </div>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {db.image} · :{db.port} · {formatBytes(db.storageLimitBytes)} · {timeAgo(db.updatedAt)}
                  </p>
                </div>
                <StatusBadge status={db.status} className="shrink-0" />
              </Link>
            ))}
          </div>
        </Card>
      )}

      <Modal
        isOpen={open}
        onClose={close}
        width="520px"
        maxWidth="520px"
        height="min(680px, calc(100vh - 48px))"
        contentRef={modalContentRef}
        footer={
          <div className="flex items-center justify-between border-t border-border/60 px-6 py-4">
            <div className="flex items-center gap-2.5 text-[11px] text-muted-foreground">
              <DbLogo type={typeInfo.key} className={cn("size-4", DB_COLORS[typeInfo.key])} />
              <span className="font-medium text-foreground whitespace-nowrap">
                {typeInfo.label} <span className="font-normal text-muted-foreground/50">·</span> {typeInfo.defaultPort}
              </span>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={close} disabled={creating}>
                Cancel
              </Button>
              <Button onClick={create} disabled={creating || !form.serverId || form.name.trim().length < 2}>
                {creating ? <Loader2 className="size-4 animate-spin" /> : <DbIcon className="size-4" />}
                Create Database
              </Button>
            </div>
          </div>
        }
      >
        <div className="p-6">
          {/* Header */}
          <div className="pr-10">
            <h2 className="text-lg font-semibold text-foreground">Databases</h2>
            <p className="mt-1 text-sm text-muted-foreground">Select a database</p>
          </div>

          {/* Type grid */}
          <div className="mt-5 grid grid-cols-3 gap-2">
            {DB_TYPES.map((t) => {
              const selected = form.type === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => pickType(t.key)}
                  className={cn(
                    "flex h-[76px] cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border transition-all duration-150",
                    selected
                      ? "border-foreground/40 bg-foreground/[0.04] ring-1 ring-inset ring-foreground/15"
                      : "border-border/80 bg-muted/20 hover:border-foreground/25 hover:bg-foreground/[0.03]",
                  )}
                >
                  <DbLogo type={t.key} className={cn("size-8", DB_COLORS[t.key])} />
                  <span className={cn("text-xs font-medium leading-none", selected ? "text-foreground" : "text-muted-foreground")}>
                    {t.label}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Form */}
          <p className="mt-6 text-[13px] font-medium text-foreground">Fill the next fields.</p>

          <div className="mt-4 space-y-4">
            {/* Server */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Label className="text-[13px]">Server</Label>
                <span title={HELP.server} className="cursor-help">
                  <CircleHelp className="size-3.5 text-muted-foreground/60" />
                </span>
              </div>
              <CustomSelect
                value={form.serverId}
                options={serverOptions}
                onChange={(v) => setForm((f) => ({ ...f, serverId: v }))}
                placeholder="Select a server"
              />
            </div>

            {/* Name */}
            <div className="space-y-1.5">
              <Label className="text-[13px]">Name</Label>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Database" className={inputCls} />
            </div>

            {/* Version */}
            <div className="space-y-1.5">
              <Label className="text-[13px]">Version</Label>
              <CustomSelect
                value={form.version}
                options={versionOptions}
                onChange={(v) => setForm((f) => ({ ...f, version: v }))}
                placeholder="Select a version"
              />
            </div>

            {/* App Name → project */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Label className="text-[13px]">App Name</Label>
                <span title={HELP.appName} className="cursor-help">
                  <CircleHelp className="size-3.5 text-muted-foreground/60" />
                </span>
              </div>
              <CustomSelect
                value={form.projectId}
                options={projectOptions}
                onChange={(v) => setForm((f) => ({ ...f, projectId: v }))}
                placeholder="No project"
              />
            </div>

            {/* Description */}
            <div className="space-y-1.5">
              <Label className="text-[13px]">Description</Label>
              <textarea
                rows={2}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Description"
                className={cn(
                  "w-full resize-none rounded-lg border border-input bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-ring/70 focus:outline-none focus:ring-2 focus:ring-ring/15",
                )}
              />
            </div>

            {/* Database Name */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Label className="text-[13px]">Database Name</Label>
                <span title={HELP.dbName} className="cursor-help">
                  <CircleHelp className="size-3.5 text-muted-foreground/60" />
                </span>
              </div>
              <Input value={form.dbName} onChange={(e) => setForm((f) => ({ ...f, dbName: e.target.value }))} placeholder={form.name || "Database Name"} className={inputCls} />
            </div>

            {/* Database User — kept always visible so the layout never moves when switching types */}
            <div className="space-y-1.5">
              <Label className="text-[13px]">Database User</Label>
              <Input
                value={form.username}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                placeholder={form.type === "MONGODB" ? "root" : "Default user"}
                className={cn(inputCls, form.type === "REDIS" && "opacity-50")}
                disabled={form.type === "REDIS"}
              />
            </div>

            {/* Database Password — kept always visible so the layout never moves when switching types */}
            <div className="space-y-1.5">
              <Label className="text-[13px]">Database Password</Label>
              <Input
                type="password"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                placeholder="••••••••"
                className={cn(inputCls, form.type === "REDIS" && "opacity-50")}
                disabled={form.type === "REDIS"}
                onKeyDown={(e) => e.key === "Enter" && create()}
              />
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
