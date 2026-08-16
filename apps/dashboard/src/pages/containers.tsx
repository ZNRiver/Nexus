import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Box, Play, Square, RotateCw, Pause, PlayCircle, Trash2, Terminal, Server as ServerIcon, CloudOff } from "lucide-react";
import { get, post } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { PageHeader } from "@/components/page-header";
import { TableSkeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { CustomSelect } from "@/components/ui/custom-select";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useToast } from "@/components/toast";
import { formatBytes, timeAgo, shortId } from "@/lib/format";
import type { ContainerInfo, Server } from "@nexus/types";

const ACTIONS: { action: string; label: string; icon: React.ElementType; confirm?: boolean }[] = [
  { action: "start", label: "Start", icon: Play },
  { action: "stop", label: "Stop", icon: Square },
  { action: "restart", label: "Restart", icon: RotateCw },
  { action: "pause", label: "Pause", icon: Pause },
  { action: "unpause", label: "Unpause", icon: PlayCircle },
  { action: "remove", label: "Remove", icon: Trash2, confirm: true },
];

/** A container plus the server it lives on, so actions can target the right host. */
interface ContainerRow extends ContainerInfo {
  serverId: string;
  serverName: string;
}

export function ContainersPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [serverFilter, setServerFilter] = useState("");
  const [actionTarget, setActionTarget] = useState<{ action: string; container: ContainerRow } | null>(null);
  const [working, setWorking] = useState(false);
  const [execTarget, setExecTarget] = useState<ContainerRow | null>(null);
  const [execCmd, setExecCmd] = useState("sh");
  const [execOut, setExecOut] = useState("");
  const [executing, setExecuting] = useState(false);

  const { data: servers } = useQuery({ queryKey: ["servers"], queryFn: () => get<{ items: Server[] }>("/servers") });

  // Empty filter = all online servers (the API aggregates when serverId is omitted).
  const { data, isLoading } = useQuery({
    queryKey: ["containers", serverFilter],
    queryFn: () => get<{ items: { serverId: string; containers: ContainerInfo[] }[] }>("/containers", { serverId: serverFilter }),
    enabled: true,
    refetchInterval: 8000,
  });
  const serverName = (id: string) => servers?.items.find((s) => s.id === id)?.name ?? shortId(id);
  const rows: ContainerRow[] = (data?.items ?? []).flatMap((g) =>
    (g.containers ?? []).map((c) => ({ ...c, serverId: g.serverId, serverName: serverName(g.serverId) })),
  );

  const runAction = async () => {
    if (!actionTarget) return;
    setWorking(true);
    try {
      const { container, action } = actionTarget;
      await post(`/containers/${container.id}/${action}`, { force: true, volumes: action === "remove" }, { serverId: container.serverId });
      queryClient.invalidateQueries({ queryKey: ["containers"] });
      toast("success", `${action} requested`, `${container.name} · ${container.serverName}`);
    } catch (err) {
      toast("error", "Action failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setWorking(false);
      setActionTarget(null);
    }
  };

  const exec = async () => {
    if (!execTarget) return;
    setExecuting(true);
    setExecOut("");
    try {
      const res = await post<{ output: string; exitCode: number }>(`/containers/${execTarget.id}/exec`, { cmd: execCmd.split(/\s+/).filter(Boolean) }, { serverId: execTarget.serverId });
      setExecOut(res.output);
    } catch (err) {
      setExecOut(err instanceof Error ? err.message : "exec failed");
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title="Containers"
        description="Every container across your online servers."
        actions={
          <CustomSelect
            value={serverFilter}
            options={[
              { value: "", label: "All servers", description: "every online server" },
              ...(servers?.items ?? []).map((s) => ({ value: s.id, label: s.name, description: s.status })),
            ]}
            onChange={(v) => setServerFilter(v)}
            placeholder="All servers"
            className="w-full sm:w-56"
          />
        }
      />

      {isLoading ? (
        <TableSkeleton rows={8} cols={5} />
      ) : !rows.length && (servers?.items ?? []).length > 0 && (servers?.items ?? []).every((s) => s.status !== "ONLINE") ? (
        <EmptyState
          icon={<CloudOff className="size-5" />}
          title="All servers offline"
          description="Containers can't be listed while no server is reporting. Bring a server back online to see its containers here."
        />
      ) : !rows.length ? (
        <EmptyState icon={<Box className="size-5" />} title="No containers" description="Containers across your servers will appear here — deploy an application or create a database." />
      ) : (
        <Card className="overflow-hidden">
          <div className="divide-y divide-border/50">
            {rows.map((c) => (
              <div key={`${c.serverId}:${c.id}`} className="flex items-center gap-4 px-5 py-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <Box className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate text-sm font-semibold">
                    <span className="truncate">{c.name}</span>
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      <ServerIcon className="size-3" /> {c.serverName}
                    </span>
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {c.image} · {shortId(c.id)} · {(c.ports ?? []).map((p) => (p.publicPort ? `${p.publicPort}:${p.privatePort}` : `${p.privatePort}`)).join(", ") || "no ports"} · {timeAgo(c.created)}
                  </p>
                  {c.cpuPercent != null && (
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      CPU {c.cpuPercent.toFixed(1)}% · Mem {formatBytes(c.memoryUsageBytes)} / {formatBytes(c.memoryLimitBytes)}
                    </p>
                  )}
                </div>
                <div className="hidden shrink-0 items-center gap-1 md:flex">
                  {ACTIONS.map(({ action, label, icon: Icon }) => (
                    <Button key={action} size="sm" variant="ghost" title={label} onClick={() => setActionTarget({ action, container: c })} className="text-muted-foreground hover:text-foreground">
                      <Icon className="size-3.5" />
                    </Button>
                  ))}
                  <Button size="sm" variant="ghost" title="Exec" className="text-muted-foreground hover:text-foreground" onClick={() => { setExecTarget(c); setExecOut(""); setExecCmd("sh"); }}>
                    <Terminal className="size-3.5" />
                  </Button>
                </div>
                <StatusBadge status={(c.state ?? "unknown").toUpperCase()} className="shrink-0" />
              </div>
            ))}
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={!!actionTarget && actionTarget.action === "remove"}
        onClose={() => setActionTarget(null)}
        onConfirm={runAction}
        loading={working}
        title="Remove container"
        description="The container will be removed from its server. Its volumes are kept unless destroyed separately."
        resourceName={actionTarget?.container.name ?? ""}
        confirmLabel="Remove"
      />

      <Modal isOpen={!!actionTarget && actionTarget.action !== "remove"} onClose={() => setActionTarget(null)} maxWidth="400px">
        <div className="p-4 sm:p-6">
          <h2 className="text-sm font-semibold">
            {actionTarget?.action} {actionTarget?.container.name}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">The agent will run this operation on {actionTarget?.container.serverName}.</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setActionTarget(null)}>Cancel</Button>
            <Button onClick={runAction} disabled={working}>
              {working ? "Working…" : `${actionTarget?.action}`}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={!!execTarget} onClose={() => setExecTarget(null)} maxWidth="640px">
        <div className="p-4 sm:p-6">
          <h2 className="text-sm font-semibold">Exec in {execTarget?.name}</h2>
          <p className="mt-1 text-xs text-muted-foreground">Running on {execTarget?.serverName}.</p>
          <div className="mt-4 flex gap-2">
            <input
              className="flex-1 rounded-xl border border-input bg-background px-3.5 py-2 font-mono text-xs focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/40"
              value={execCmd}
              onChange={(e) => setExecCmd(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && exec()}
              placeholder="sh -lc 'echo hi'"
            />
            <Button onClick={exec} disabled={executing}>
              {executing ? "Running…" : "Run"}
            </Button>
          </div>
          {execOut && <pre className="mt-3 max-h-64 overflow-auto rounded-xl bg-black/80 p-3 font-mono text-[11px] text-green-400">{execOut}</pre>}
        </div>
      </Modal>
    </div>
  );
}
