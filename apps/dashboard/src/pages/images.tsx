import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Image as ImageIcon, Download, Trash2, Loader2 } from "lucide-react";
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
import { formatBytes, timeAgo } from "@/lib/format";
import type { ImageInfo, Server } from "@nexus/types";

export function ImagesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [serverId, setServerId] = useState("");
  const [pullOpen, setPullOpen] = useState(false);
  const [pullImage, setPullImage] = useState("");
  const [pulling, setPulling] = useState(false);
  const [toRemove, setToRemove] = useState<ImageInfo | null>(null);
  const [removing, setRemoving] = useState(false);

  const { data: servers } = useQuery({ queryKey: ["servers"], queryFn: () => get<{ items: Server[] }>("/servers") });
  const effectiveServer = serverId || servers?.items.find((s) => s.status === "ONLINE")?.id || "";

  const { data, isLoading } = useQuery({
    queryKey: ["images", effectiveServer],
    queryFn: () => get<{ items: ImageInfo[] }>("/images", { serverId: effectiveServer }),
    enabled: !!effectiveServer,
    refetchInterval: 15000,
  });

  const pull = async () => {
    setPulling(true);
    try {
      await post("/images/pull", { serverId: effectiveServer, image: pullImage });
      queryClient.invalidateQueries({ queryKey: ["images"] });
      toast("success", "Image pulled", pullImage);
      setPullOpen(false);
      setPullImage("");
    } catch (err) {
      toast("error", "Pull failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setPulling(false);
    }
  };

  const remove = async () => {
    if (!toRemove) return;
    setRemoving(true);
    try {
      await del("/images", { serverId: effectiveServer, image: `${toRemove.repository}:${toRemove.tag}` });
      queryClient.invalidateQueries({ queryKey: ["images"] });
      toast("success", "Image removed", `${toRemove.repository}:${toRemove.tag}`);
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
        title="Images"
        description="Docker images available on the selected server."
        actions={
          <div className="flex gap-2">
            <CustomSelect
              value={effectiveServer}
              options={(servers?.items ?? []).map((s) => ({ value: s.id, label: s.name, description: s.status }))}
              onChange={(v) => setServerId(v)}
              placeholder="Select a server"
              className="w-56"
            />
            <Button onClick={() => setPullOpen(true)} disabled={!effectiveServer}>
              <Download className="size-4" /> Pull
            </Button>
          </div>
        }
      />

      {isLoading ? (
        <TableSkeleton rows={8} cols={4} />
      ) : !data?.items.length ? (
        <EmptyState icon={<ImageIcon className="size-5" />} title="No images" description="Pull an image or deploy an application — built images land here." />
      ) : (
        <Card className="overflow-hidden">
          <div className="divide-y divide-border/50">
            {data.items.map((img) => (
              <div key={img.id} className="flex items-center gap-4 px-5 py-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <ImageIcon className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">
                    {img.repository}:<span className="text-muted-foreground">{img.tag}</span>
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {img.id ? img.id.slice(7, 19) : "—"} · {formatBytes(img.sizeBytes)} · created {timeAgo(img.created)}
                  </p>
                </div>
                {img.containers > 0 ? (
                  <span className="shrink-0 rounded-lg bg-muted px-2 py-1 text-[11px] text-muted-foreground">{img.containers} in use</span>
                ) : (
                  <Button size="sm" variant="ghost" title="Remove" onClick={() => setToRemove(img)} className="text-muted-foreground hover:text-destructive">
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      <Modal isOpen={pullOpen} onClose={() => setPullOpen(false)} maxWidth="440px">
        <div className="p-6">
          <h2 className="text-sm font-semibold">Pull image</h2>
          <p className="mt-1 text-xs text-muted-foreground">Pulled on {servers?.items.find((s) => s.id === effectiveServer)?.name}.</p>
          <div className="mt-5 space-y-1.5">
            <Label>Image</Label>
            <Input value={pullImage} onChange={(e) => setPullImage(e.target.value)} placeholder="nginx:1.27" autoFocus onKeyDown={(e) => e.key === "Enter" && pull()} />
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setPullOpen(false)}>Cancel</Button>
            <Button onClick={pull} disabled={pulling || !pullImage.trim()}>
              {pulling ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} Pull
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!toRemove}
        onClose={() => setToRemove(null)}
        onConfirm={remove}
        loading={removing}
        title="Remove image"
        description="The image will be removed from the server. Images in use by containers cannot be removed."
        resourceName={toRemove ? `${toRemove.repository}:${toRemove.tag}` : ""}
        confirmLabel="Remove"
      />
    </div>
  );
}
