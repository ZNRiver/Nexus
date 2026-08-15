import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive, Plus, Trash2, Loader2 } from "lucide-react";
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
import { formatBytes } from "@/lib/format";
import type { Server, VolumeInfo } from "@nexus/types";

export function VolumesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [serverId, setServerId] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [toRemove, setToRemove] = useState<VolumeInfo | null>(null);
  const [removing, setRemoving] = useState(false);

  const { data: servers } = useQuery({ queryKey: ["servers"], queryFn: () => get<{ items: Server[] }>("/servers") });
  const effectiveServer = serverId || servers?.items.find((s) => s.status === "ONLINE")?.id || "";

  const { data, isLoading } = useQuery({
    queryKey: ["volumes", effectiveServer],
    queryFn: () => get<{ items: VolumeInfo[] }>("/volumes", { serverId: effectiveServer }),
    enabled: !!effectiveServer,
    refetchInterval: 15000,
  });

  const create = async () => {
    setCreating(true);
    try {
      await post("/volumes", { serverId: effectiveServer, name });
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
      await del(`/volumes/${toRemove.name}`, { serverId: effectiveServer, force: "true" });
      queryClient.invalidateQueries({ queryKey: ["volumes"] });
      toast("success", "Volume removed", toRemove.name);
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
        description="Persistent storage available on the selected server."
        actions={
          <div className="flex gap-2">
            <CustomSelect
              value={effectiveServer}
              options={(servers?.items ?? []).map((s) => ({ value: s.id, label: s.name, description: s.status }))}
              onChange={(v) => setServerId(v)}
              placeholder="Select a server"
              className="w-56"
            />
            <Button onClick={() => setCreateOpen(true)} disabled={!effectiveServer}>
              <Plus className="size-4" /> Create
            </Button>
          </div>
        }
      />

      {isLoading ? (
        <TableSkeleton rows={6} cols={4} />
      ) : !data?.items.length ? (
        <EmptyState icon={<HardDrive className="size-5" />} title="No volumes" description="Create a volume or deploy an application with persistent storage." />
      ) : (
        <Card className="overflow-hidden">
          <div className="divide-y divide-border/50">
            {data.items.map((v) => (
              <div key={v.name} className="flex items-center gap-4 px-5 py-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <HardDrive className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{v.name}</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {v.driver} · {formatBytes(v.sizeBytes)} · {(v.usedBy ?? []).length ? `used by ${(v.usedBy ?? []).join(", ")}` : "not in use"}
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
          <p className="mt-1 text-xs text-muted-foreground">Created on {servers?.items.find((s) => s.id === effectiveServer)?.name}.</p>
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
