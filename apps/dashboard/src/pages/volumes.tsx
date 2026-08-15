import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive, Plus, Trash2, Loader2, Server as ServerIcon } from "lucide-react";
import { get, post, del } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { TableSkeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { CustomSelect } from "@/components/ui/custom-select";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useToast } from "@/components/toast";
import { formatBytes, shortId } from "@/lib/format";
import type { Server, VolumeInfo } from "@nexus/types";

/** A volume plus the server it lives on, so actions can target the right host. */
interface VolumeRow extends VolumeInfo {
  serverId: string;
  serverName: string;
}

export function VolumesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [serverFilter, setServerFilter] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [toRemove, setToRemove] = useState<VolumeRow | null>(null);
  const [removing, setRemoving] = useState(false);

  const { data: servers } = useQuery({ queryKey: ["servers"], queryFn: () => get<{ items: Server[] }>("/servers") });

  const { data, isLoading } = useQuery({
    queryKey: ["volumes", serverFilter],
    queryFn: () => get<{ items: { serverId: string; volumes: VolumeInfo[] }[] }>("/volumes", { serverId: serverFilter }),
    enabled: true,
    refetchInterval: 15000,
  });
  const serverName = (id: string) => servers?.items.find((s) => s.id === id)?.name ?? shortId(id);
  const volumes: VolumeRow[] = (data?.items ?? []).flatMap((g) =>
    (g.volumes ?? []).map((v) => ({ ...v, serverId: g.serverId, serverName: serverName(g.serverId) })),
  );

  // Create targets a specific server: the selected filter, or the first online one.
  const createServerId = serverFilter || servers?.items.find((s) => s.status === "ONLINE")?.id || "";

  const create = async () => {
    setCreating(true);
    try {
      await post("/volumes", { serverId: createServerId, name });
      queryClient.invalidateQueries({ queryKey: ["volumes"] });
      toast("success", "Volume created", name);
      setCreateOpen(false);
      setName("");
    } catch (err) {
      toast("error", "Creation failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setCreating(false);
    }
  };

  const remove = async () => {
    if (!toRemove) return;
    setRemoving(true);
    try {
      await del(`/volumes/${toRemove.name}`, { serverId: toRemove.serverId, force: "true" });
      queryClient.invalidateQueries({ queryKey: ["volumes"] });
      toast("success", "Volume removed", `${toRemove.name} · ${toRemove.serverName}`);
      setToRemove(null);
    } catch (err) {
      toast("error", "Remove failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="p-6">
      <PageHeader
        title="Volumes"
        description="Persistent storage across your online servers — including application and database volumes."
        actions={
          <div className="flex gap-2">
            <CustomSelect
              value={serverFilter}
              options={[
                { value: "", label: "All servers", description: "every online server" },
                ...(servers?.items ?? []).map((s) => ({ value: s.id, label: s.name, description: s.status })),
              ]}
              onChange={(v) => setServerFilter(v)}
              placeholder="All servers"
              className="w-56"
            />
            <Button onClick={() => setCreateOpen(true)} disabled={!createServerId}>
              <Plus className="size-4" /> Create
            </Button>
          </div>
        }
      />

      {isLoading ? (
        <TableSkeleton rows={6} cols={4} />
      ) : !volumes.length ? (
        <EmptyState icon={<HardDrive className="size-5" />} title="No volumes" description="Create a volume or deploy an application with persistent storage." />
      ) : (
        <Card className="overflow-hidden">
          <div className="divide-y divide-border/50">
            {volumes.map((v) => (
              <div key={`${v.serverId}:${v.name}`} className="flex items-center gap-4 px-5 py-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <HardDrive className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate text-sm font-semibold">
                    <span className="truncate">{v.name}</span>
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      <ServerIcon className="size-3" /> {v.serverName}
                    </span>
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {v.driver} · {v.sizeBytes != null ? formatBytes(v.sizeBytes) : "unknown size"} · {(v.usedBy ?? []).length ? `used by ${(v.usedBy ?? []).join(", ")}` : "not in use"}
                  </p>
                </div>
                {(v.usedBy ?? []).length === 0 ? (
                  <Button size="sm" variant="ghost" onClick={() => setToRemove(v)} className="shrink-0 text-muted-foreground hover:text-destructive">
                    <Trash2 className="size-4" />
                  </Button>
                ) : (
                  <span className="shrink-0 rounded-lg bg-muted px-2 py-1 text-[11px] text-muted-foreground">{(v.usedBy ?? []).length} dependent</span>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      <Modal isOpen={createOpen} onClose={() => setCreateOpen(false)} maxWidth="440px">
        <div className="p-6">
          <h2 className="text-sm font-semibold">Create volume</h2>
          <p className="mt-1 text-xs text-muted-foreground">Created on {servers?.items.find((s) => s.id === createServerId)?.name ?? "selected server"}.</p>
          <div className="mt-5 space-y-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="nexus-data" autoFocus onKeyDown={(e) => e.key === "Enter" && create()} />
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={create} disabled={creating || !name.trim()}>
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Create
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!toRemove}
        onClose={() => setToRemove(null)}
        onConfirm={remove}
        loading={removing}
        title="Remove volume"
        description="All data stored on this volume will be permanently lost."
        resourceName={toRemove?.name ?? ""}
        confirmLabel="Remove"
      />
    </div>
  );
}
