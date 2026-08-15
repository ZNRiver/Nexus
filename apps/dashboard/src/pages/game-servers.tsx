import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Gamepad2, Plus, Loader2, Check, Play, Square } from "lucide-react";
import { get, post } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
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
import type { GameServer, MinecraftFlavor, Server } from "@nexus/types";

const FLAVORS: { key: MinecraftFlavor; label: string }[] = [
  { key: "PAPER", label: "Paper" },
  { key: "PURPUR", label: "Purpur" },
  { key: "FABRIC", label: "Fabric" },
  { key: "FORGE", label: "Forge" },
  { key: "VANILLA", label: "Vanilla" },
];

const VERSIONS = ["1.21.4", "1.21.3", "1.21.1", "1.21", "1.20.6", "1.20.4", "1.20.1"];

export function GameServersPage({ mode }: { mode?: string }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(mode === "new" || params.get("new") === "1");
  const [creating, setCreating] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    serverId: "",
    flavor: "PAPER" as MinecraftFlavor,
    version: "1.21.4",
    port: "25565",
    memoryBytes: "4096",
    cpuLimit: "2",
    storageBytes: "20",
  });

  const { data: servers } = useQuery({ queryKey: ["servers"], queryFn: () => get<{ items: Server[] }>("/servers") });
  const { data: games, isLoading } = useQuery({ queryKey: ["game-servers"], queryFn: () => get<{ items: GameServer[] }>("/game-servers"), refetchInterval: 10000 });

  const close = () => {
    setOpen(false);
    setParams({}, { replace: true });
  };

  const create = async () => {
    setCreating(true);
    try {
      const res = await post<{ gameServer: { id: string } }>("/game-servers", {
        name: form.name,
        serverId: form.serverId,
        game: "MINECRAFT",
        version: form.version,
        flavor: form.flavor,
        port: parseInt(form.port, 10),
        memoryBytes: parseInt(form.memoryBytes, 10) * 1024 * 1024,
        cpuLimit: parseFloat(form.cpuLimit),
        storageBytes: parseInt(form.storageBytes, 10) * 1024 * 1024 * 1024,
        environment: { EULA: "TRUE", MEMORY: `${form.memoryBytes}M` },
      });
      toast("success", "Game server created", form.name);
      navigate(`/game-servers?created=${res.gameServer.id}`);
      close();
      queryClient.invalidateQueries({ queryKey: ["game-servers"] });
    } catch (err) {
      toast("error", "Creation failed", err instanceof Error ? err.message : "Unknown error");
      setCreating(false);
    }
  };

  const toggle = async (g: GameServer) => {
    setWorking(g.id);
    try {
      await post(`/game-servers/${g.id}/${g.status === "RUNNING" ? "stop" : "start"}`);
      queryClient.invalidateQueries({ queryKey: ["game-servers"] });
    } catch (err) {
      toast("error", "Action failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="p-6">
      <PageHeader
        title="Game Servers"
        description="Minecraft servers running in containers with persistent storage."
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus className="size-4" /> New Game Server
          </Button>
        }
      />

      {isLoading ? (
        <TableSkeleton rows={5} cols={4} />
      ) : !games?.items.length ? (
        <EmptyState
          icon={<Gamepad2 className="size-5" />}
          title="No game servers"
          description="Spin up a Minecraft server on any node — Paper, Purpur, Fabric, Forge or Vanilla."
          actionLabel="New Game Server"
          onAction={() => setOpen(true)}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {games.items.map((g) => (
            <Card key={g.id} className="group p-5 transition-colors hover:border-border card-hover">
              <Link to={`/game-servers/${g.id}`} className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex size-9 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                    <Gamepad2 className="size-4" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold">{g.name}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {g.flavor} {g.version} · :{g.port}
                    </p>
                  </div>
                </div>
                <StatusBadge status={g.status} />
              </Link>
              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl bg-muted/50 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Memory</p>
                  <p className="text-xs font-medium tabular">{formatBytes(g.memoryBytes)}</p>
                </div>
                <div className="rounded-xl bg-muted/50 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">CPU</p>
                  <p className="text-xs font-medium tabular">{g.cpuLimit ? `${g.cpuLimit} cores` : "—"}</p>
                </div>
                <div className="rounded-xl bg-muted/50 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Storage</p>
                  <p className="text-xs font-medium tabular">{formatBytes(g.storageBytes)}</p>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>{timeAgo(g.updatedAt)}</span>
                <Button size="sm" variant="outline" onClick={() => toggle(g)} disabled={working === g.id || ["CREATING", "REMOVING", "STARTING"].includes(g.status)}>
                  {working === g.id ? <Loader2 className="size-3.5 animate-spin" /> : g.status === "RUNNING" ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
                  {g.status === "RUNNING" ? "Stop" : "Start"}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        isOpen={open}
        onClose={close}
        width="560px"
        maxWidth="560px"
        height="min(680px, calc(100vh - 48px))"
        footer={
          <div className="flex justify-end gap-2 border-t border-border/60 px-6 py-4">
            <Button variant="outline" onClick={close}>Cancel</Button>
            <Button onClick={create} disabled={creating || !form.serverId || form.name.trim().length < 2}>
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Gamepad2 className="size-4" />} Create
            </Button>
          </div>
        }
      >
        <div className="p-6">
          <h2 className="text-sm font-semibold">New Game Server</h2>
          <p className="mt-1 text-xs text-muted-foreground">Minecraft · containers on the chosen server.</p>

          <div className="mt-5 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Name</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="survival-01" />
              </div>
              <div className="space-y-1.5">
                <Label>Flavor</Label>
                <CustomSelect
                  value={form.flavor}
                  options={FLAVORS.map((f) => ({ value: f.key, label: f.label }))}
                  onChange={(v) => setForm({ ...form, flavor: v })}
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>Version</Label>
                <CustomSelect
                  value={form.version}
                  options={VERSIONS.map((v) => ({ value: v, label: v }))}
                  onChange={(v) => setForm({ ...form, version: v })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Port</Label>
                <Input type="number" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>Memory (MB)</Label>
                <Input type="number" value={form.memoryBytes} onChange={(e) => setForm({ ...form, memoryBytes: e.target.value })} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>CPU cores</Label>
                <Input type="number" step="0.5" value={form.cpuLimit} onChange={(e) => setForm({ ...form, cpuLimit: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>Storage (GB)</Label>
                <Input type="number" value={form.storageBytes} onChange={(e) => setForm({ ...form, storageBytes: e.target.value })} />
              </div>
            </div>

            <div>
              <Label className="mb-2 block">Server</Label>
              <div className="space-y-2">
                {servers?.items.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setForm({ ...form, serverId: s.id })}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl border px-4 py-2.5 text-start transition-colors",
                      form.serverId === s.id ? "border-primary bg-primary/[0.06]" : "border-border hover:bg-foreground/[0.05]",
                    )}
                  >
                    <div className="flex-1">
                      <p className="text-sm font-medium">{s.name}</p>
                      <p className="text-[11px] text-muted-foreground">{s.host} · {s.status}</p>
                    </div>
                    {form.serverId === s.id && <Check className="size-4 text-primary" />}
                  </button>
                ))}
              </div>
            </div>

          </div>
        </div>
      </Modal>
    </div>
  );
}
