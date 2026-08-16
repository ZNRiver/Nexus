import { useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Server as ServerIcon, Plus, Loader2, KeyRound, ShieldCheck, RotateCcw, X } from "lucide-react";
import { get, post } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CustomSelect } from "@/components/ui/custom-select";
import { Modal } from "@/components/ui/Modal";
import { StatusBadge } from "@/components/status-badge";
import { PageHeader } from "@/components/page-header";
import { TableSkeleton, Skeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { useToast } from "@/components/toast";
import { formatBytes, timeAgo } from "@/lib/format";
import type { Server } from "@nexus/types";

export function ServersPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [modalOpen, setModalOpen] = useState(params.get("new") === "1");
  const modalContentRef = useRef<HTMLDivElement>(null);
  const [form, setForm] = useState({ name: "", host: "", port: "22", username: "root", authMethod: "password", password: "", privateKey: "", agentApiUrl: "" });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; system?: { arch?: string; dockerVersion?: string | null; os?: string } } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const { data, isLoading } = useQuery({ queryKey: ["servers"], queryFn: () => get<{ items: Server[] }>("/servers"), refetchInterval: 10000 });

  const closeModal = () => {
    setModalOpen(false);
    setParams({}, { replace: true });
  };

  const testConnection = async () => {
    setTesting(true);
    setError("");
    setTestResult(null);
    try {
      const res = await post<{ ok: boolean; message: string; system?: { arch?: string; dockerVersion?: string | null; os?: string } }>("/servers/test", {
        name: form.name,
        host: form.host,
        port: parseInt(form.port, 10),
        username: form.username,
        authMethod: form.authMethod,
        password: form.authMethod === "password" ? form.password : undefined,
        privateKey: form.authMethod === "privateKey" ? form.privateKey : undefined,
      });
      setTestResult(res);
      if (!res.ok) setError(res.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection test failed");
    } finally {
      setTesting(false);
    }
  };

  const retryInstall = async (s: Server) => {
    setRetryingId(s.id);
    try {
      await post(`/servers/${s.id}/install-agent`);
      toast("info", "Retrying install…", `${s.name} is being provisioned again`);
      queryClient.invalidateQueries({ queryKey: ["servers"] });
    } catch (err) {
      toast("error", "Retry failed", err instanceof Error ? err.message : "Could not start installation");
    } finally {
      setRetryingId(null);
    }
  };

  const addServer = async (install: boolean) => {
    setInstalling(true);
    setError("");
    try {
      const res = await post<{ server: Server }>("/servers", {
        name: form.name,
        host: form.host,
        port: parseInt(form.port, 10),
        username: form.username,
        authMethod: form.authMethod,
        password: form.authMethod === "password" ? form.password : undefined,
        privateKey: form.authMethod === "privateKey" ? form.privateKey : undefined,
        agentApiUrl: form.agentApiUrl.trim() || undefined,
      });
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      if (install) {
        toast("info", "Installing NEXUS Agent…", `${form.name} is being provisioned`);
        await post(`/servers/${res.server.id}/install-agent`).catch((err) => toast("error", "Install failed", err.message));
        closeModal();
        navigate(`/servers/${res.server.id}`);
      } else {
        toast("success", "Server added", `${form.name} saved — install the agent to deploy`);
        closeModal();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add server");
      setInstalling(false);
    }
  };

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title="Servers"
        description="Local and remote machines running the NEXUS Agent."
        actions={
          <Button onClick={() => { setModalOpen(true); setForm({ name: "", host: "", port: "22", username: "root", authMethod: "password", password: "", privateKey: "", agentApiUrl: "" }); setTestResult(null); setError(""); }}>
            <Plus className="size-4" /> Add Server
          </Button>
        }
      />

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="p-5 space-y-3">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-3 w-24" />
            </Card>
          ))}
        </div>
      ) : !data?.items.length ? (
        <EmptyState
          icon={<ServerIcon className="size-5" />}
          title="No servers yet"
          description="Connect your first server to deploy infrastructure. The Local Server is created during setup."
          actionLabel="Add Server"
          onAction={() => setModalOpen(true)}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.items.map((s) => (
            <Link key={s.id} to={`/servers/${s.id}`}>
              <Card className="p-5 card-hover">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex size-9 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                      <ServerIcon className="size-4" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold">{s.name}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {s.host}:{s.port} · {s.type}
                      </p>
                    </div>
                  </div>
                  <StatusBadge status={s.status} />
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-xl bg-muted/50 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">CPU</p>
                    <p className="text-xs font-medium tabular">{s.cpuCores ? `${s.cpuCores} cores` : "—"}</p>
                  </div>
                  <div className="rounded-xl bg-muted/50 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">RAM</p>
                    <p className="text-xs font-medium tabular">{formatBytes(s.memoryTotalBytes)}</p>
                  </div>
                  <div className="rounded-xl bg-muted/50 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Docker</p>
                    <p className="text-xs font-medium tabular">{s.dockerVersion ?? "—"}</p>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <ShieldCheck className="size-3" /> Agent {s.agentVersion ?? "not installed"}
                  </span>
                  <span>hb {timeAgo(s.lastHeartbeatAt)}</span>
                </div>
                {s.status === "ERROR" && (
                  <div className="mt-3 border-t border-border/60 pt-3">
                    {s.lastError && <p className="mb-2 line-clamp-2 text-[11px] text-destructive">{s.lastError}</p>}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void retryInstall(s);
                      }}
                      disabled={retryingId === s.id}
                      title={s.lastError ? `Retry agent installation — ${s.lastError}` : "Retry agent installation"}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-foreground/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {retryingId === s.id ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
                      Try again
                    </button>
                  </div>
                )}
              </Card>
            </Link>
          ))}
        </div>
      )}

      <Modal
        isOpen={modalOpen}
        onClose={closeModal}
        width="520px"
        maxWidth="520px"
        height="min(680px, calc(100vh - 48px))"
        contentRef={modalContentRef}
        footer={
          <div className="flex items-center justify-end gap-2 border-t border-border/60 px-6 py-4">
            <Button variant="outline" onClick={testConnection} disabled={testing || !form.host}>
              {testing ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
              Test Connection
            </Button>
            <Button variant="outline" onClick={() => addServer(false)} disabled={installing || !form.name || !form.host}>
              Add only
            </Button>
            <Button onClick={() => addServer(true)} disabled={installing || !form.name || !form.host || !testResult?.ok}>
              {installing ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Install Agent
            </Button>
          </div>
        }
      >
        <div className="p-4 sm:p-6">
          <h2 className="text-sm font-semibold">Add Remote Server</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            NEXUS connects over SSH and runs the full setup: installs <span className="font-medium text-foreground/80">Docker Engine</span> (if missing), <span className="font-medium text-foreground/80">Bun</span> and the <span className="font-medium text-foreground/80">NEXUS Agent</span> as a systemd service.
          </p>

          <div className="mt-5 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Name</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Production-01" />
              </div>
              <div className="space-y-1.5">
                <Label>Host</Label>
                <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="203.0.113.10" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Port</Label>
                <Input type="number" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>Username</Label>
                <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="root" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Authentication</Label>
              <CustomSelect
                value={form.authMethod}
                options={[
                  { value: "password", label: "SSH Password" },
                  { value: "privateKey", label: "SSH Private Key" },
                ]}
                onChange={(v) => {
                  setForm({ ...form, authMethod: v });
                  modalContentRef.current?.scrollTo({ top: 0 });
                }}
              />
            </div>
            {form.authMethod === "password" ? (
              <div className="space-y-1.5">
                <Label>Password</Label>
                <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="••••••••" />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label>Private Key</Label>
                <textarea
                  className="h-28 w-full rounded-xl border border-input bg-background px-3.5 py-2 font-mono text-xs focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/40"
                  value={form.privateKey}
                  onChange={(e) => setForm({ ...form, privateKey: e.target.value })}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label>Agent API URL (optional)</Label>
              <Input
                value={form.agentApiUrl}
                onChange={(e) => setForm({ ...form, agentApiUrl: e.target.value })}
                placeholder="http://192.168.1.3:8080"
              />
              <p className="text-[11px] text-muted-foreground">
                URL the remote agent connects back to. Leave empty to auto-detect from your network.
              </p>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
            {testResult?.ok && (
              <div className="rounded-xl border border-success/40 bg-success/10 px-4 py-3 text-sm text-success">
                <div className="flex items-center gap-2 font-medium">
                  <ShieldCheck className="size-4" /> Connection successful
                </div>
                <p className="mt-1 text-xs opacity-80">
                  {testResult.system?.os} · {testResult.system?.arch} · Docker {testResult.system?.dockerVersion ?? "missing — will be installed automatically"}
                </p>
              </div>
            )}

          </div>
        </div>
      </Modal>
    </div>
  );
}
