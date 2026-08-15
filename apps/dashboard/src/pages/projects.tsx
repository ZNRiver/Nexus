import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderKanban, Plus, Loader2 } from "lucide-react";
import { get, post, del } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PageHeader } from "@/components/page-header";
import { TableSkeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { useToast } from "@/components/toast";
import type { Project } from "@nexus/types";

export function ProjectsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", description: "" });
  const [toDelete, setToDelete] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: ["projects"], queryFn: () => get<{ items: Project[] }>("/projects") });

  const create = async () => {
    setCreating(true);
    try {
      await post("/projects", { name: form.name, description: form.description || undefined });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast("success", "Project created", form.name);
      setOpen(false);
      setForm({ name: "", description: "" });
    } catch (err) {
      toast("error", "Creation failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setCreating(false);
    }
  };

  const remove = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await del(`/projects/${toDelete.id}`);
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast("success", "Project deleted", toDelete.name);
      setToDelete(null);
    } catch (err) {
      toast("error", "Delete failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="p-6">
      <PageHeader
        title="Projects"
        description="Group applications, databases and game servers into logical workspaces."
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus className="size-4" /> New Project
          </Button>
        }
      />

      {isLoading ? (
        <TableSkeleton />
      ) : !data?.items.length ? (
        <EmptyState
          icon={<FolderKanban className="size-5" />}
          title="No projects"
          description="Create a project to organize resources across your servers."
          actionLabel="New Project"
          onAction={() => setOpen(true)}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.items.map((p) => (
            <Card key={p.id} className="p-5">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-3">
                  <div className="flex size-9 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                    <FolderKanban className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{p.name}</p>
                    <p className="text-[11px] text-muted-foreground">{p.slug}</p>
                  </div>
                </div>
                <button onClick={() => setToDelete(p)} className="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                  Delete
                </button>
              </div>
              {p.description && <p className="mt-3 line-clamp-2 text-xs text-muted-foreground">{p.description}</p>}
              <div className="mt-4 flex gap-2 text-[11px] text-muted-foreground">
                <span className="rounded-lg bg-muted px-2 py-1">{p.applicationCount ?? 0} apps</span>
                <span className="rounded-lg bg-muted px-2 py-1">{p.databaseCount ?? 0} databases</span>
                <span className="rounded-lg bg-muted px-2 py-1">{p.gameServerCount ?? 0} game servers</span>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal isOpen={open} onClose={() => setOpen(false)} maxWidth="480px">
        <div className="p-6">
          <h2 className="text-sm font-semibold">New Project</h2>
          <p className="mt-1 text-xs text-muted-foreground">Projects group resources that belong to the same product or environment.</p>
          <div className="mt-5 space-y-4">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="My SaaS" autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label>Description (optional)</Label>
              <Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What runs in this project?" />
            </div>
            <div className="flex justify-end gap-2 border-t border-border/60 pt-4">
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={create} disabled={creating || form.name.trim().length < 2}>
                {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Create
              </Button>
            </div>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={remove}
        loading={deleting}
        title="Delete project"
        description="The project will be removed. Applications, databases and game servers inside it are kept and become unassigned."
        resourceName={toDelete?.name ?? ""}
      />
    </div>
  );
}
