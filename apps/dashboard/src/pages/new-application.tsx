import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, Loader2, Boxes, Server as ServerIcon, GitBranch, FileCode2, Rocket, SlidersHorizontal, ListChecks, CircleHelp } from "lucide-react";
import { get, post } from "@/lib/api";
import { GitLogo } from "@/components/git-logos";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CustomSelect } from "@/components/ui/custom-select";
import { Switch } from "@/components/ui/Switch";
import { PageHeader } from "@/components/page-header";
import { useToast } from "@/components/toast";
import { OperationLogPanel } from "@/components/operation-log-panel";
import { cn } from "@/lib/utils";
import type { Server, Project } from "@nexus/types";

const STEPS = [
  { key: "source", label: "Source", icon: GitBranch },
  { key: "server", label: "Server", icon: ServerIcon },
  { key: "method", label: "Deployment", icon: FileCode2 },
  { key: "config", label: "Configuration", icon: SlidersHorizontal },
  { key: "review", label: "Review", icon: ListChecks },
];

interface EnvRow {
  key: string;
  value: string;
  isSecret: boolean;
}

export function NewApplicationPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [step, setStep] = useState(0);
  const [creating, setCreating] = useState(false);
  // Created application id — shows live progress while it deploys.
  const [createdAppId, setCreatedAppId] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: "",
    description: "",
    projectId: "",
    serverId: "",
    provider: "",
    repository: "",
    branch: "main",
    deploymentMethod: "DOCKERFILE" as "DOCKERFILE" | "COMPOSE",
    dockerfilePath: "Dockerfile",
    buildContext: ".",
    composePath: "docker-compose.yml",
    port: "",
    startCommand: "",
    restartPolicy: "unless-stopped",
    cpuLimit: "",
    memoryLimitBytes: "",
    healthcheckEnabled: false,
    healthcheckPath: "/",
    volumeName: "",
    volumeMountPath: "",
    registry: "",
    registryUsername: "",
    registryPassword: "",
  });
  const [env, setEnv] = useState<EnvRow[]>([]);

  const { data: servers } = useQuery({ queryKey: ["servers"], queryFn: () => get<{ items: Server[] }>("/servers") });
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: () => get<{ items: Project[] }>("/projects") });
  const { data: gitProviders } = useQuery({ queryKey: ["git-providers"], queryFn: () => get<{ items: { id: string; provider: string; name: string }[] }>("/git-providers") });

  // Repositories of the selected provider — only when the provider is a connected Git account.
  const gitKind = form.provider.toLowerCase();
  const connectedGitAccount = gitProviders?.items.find((p) => p.provider === gitKind);
  const reposQ = useQuery({
    queryKey: ["git-repos", gitKind],
    queryFn: () => get<{ items: { name: string; url: string; private: boolean; defaultBranch: string | null }[] }>(`/git-providers/${gitKind}/repos`),
    enabled: !!connectedGitAccount && ["github", "gitlab", "bitbucket", "gitea"].includes(gitKind),
    retry: false,
  });

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const setEnvRow = (i: number, patch: Partial<EnvRow>) => setEnv((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const canNext = useMemo(() => {
    switch (step) {
      case 0:
        return form.name.trim().length >= 2;
      case 1:
        return !!form.serverId;
      case 2:
        return form.repository.trim().length >= 3;
      default:
        return true;
    }
  }, [step, form]);

  const deploy = async () => {
    setCreating(true);
    try {
      const payload = {
        name: form.name,
        description: form.description || undefined,
        projectId: form.projectId || undefined,
        serverId: form.serverId,
        provider: form.provider || undefined,
        repository: form.repository,
        branch: form.branch,
        deploymentMethod: form.deploymentMethod,
        dockerfilePath: form.dockerfilePath,
        buildContext: form.buildContext,
        composePath: form.composePath,
        port: form.port ? parseInt(form.port, 10) : undefined,
        startCommand: form.startCommand || undefined,
        restartPolicy: form.restartPolicy,
        cpuLimit: form.cpuLimit ? parseFloat(form.cpuLimit) : undefined,
        memoryLimitBytes: form.memoryLimitBytes ? parseInt(form.memoryLimitBytes, 10) * 1024 * 1024 : undefined,
        healthcheck: form.healthcheckEnabled ? { type: "http" as const, path: form.healthcheckPath, port: form.port ? parseInt(form.port, 10) : undefined } : null,
        volumeName: form.volumeName || undefined,
        volumeMountPath: form.volumeMountPath || undefined,
        registry: form.registry || undefined,
        registryUsername: form.registryUsername || undefined,
        registryPassword: form.registryPassword || undefined,
        environment: env.filter((r) => r.key.trim()).map((r) => ({ key: r.key.trim(), value: r.value, isSecret: r.isSecret })),
      };
      const res = await post<{ application: { id: string } }>("/applications", payload);
      toast("success", "Application created", `${form.name} — deploying…`);
      // Kick off the first deploy immediately.
      try {
        await post<{ deploymentId: string }>(`/applications/${res.application.id}/deploy`, { branch: form.branch });
      } catch {
        /* deploy failure shows up on the detail page */
      }
      setCreating(false);
      setCreatedAppId(res.application.id);
      // Redirect to the detail page after a brief moment so the user sees the logs panel first.
      setTimeout(() => navigate(`/applications/${res.application.id}`), 1800);
    } catch (err) {
      toast("error", "Creation failed", err instanceof Error ? err.message : "Unknown error");
      setCreating(false);
    }
  };

  const steps = [
    {
      content: (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="API backend" />
          </div>
          <div className="space-y-1.5">
            <Label>Description (optional)</Label>
            <Textarea rows={2} value={form.description} onChange={(e) => set({ description: e.target.value })} placeholder="What does this service do?" />
          </div>
          <div className="space-y-1.5">
            <Label>Project (optional)</Label>
            <CustomSelect
              value={form.projectId}
              options={[
                { value: "", label: "No project" },
                ...(projects?.items ?? []).map((p) => ({ value: p.id, label: p.name })),
              ]}
              onChange={(v) => set({ projectId: v })}
            />
          </div>
        </div>
      ),
    },
    {
      content: (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Where should this application run? Resources are permanently bound to a server.</p>
          {servers?.items.map((s) => (
            <button
              key={s.id}
              onClick={() => set({ serverId: s.id })}
              className={cn(
                "flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-start transition-colors",
                form.serverId === s.id ? "border-primary bg-primary/[0.06]" : "border-border hover:border-border/80 hover:bg-foreground/[0.05]",
              )}
            >
              <ServerIcon className="size-4 text-muted-foreground" />
              <div className="flex-1">
                <p className="text-sm font-medium">{s.name}</p>
                <p className="text-[11px] text-muted-foreground">{s.host} · {s.status}</p>
              </div>
              {form.serverId === s.id && <Check className="size-4 text-primary" />}
            </button>
          ))}
          {!servers?.items.length && <p className="py-4 text-center text-sm text-muted-foreground">No servers available. Add a server first.</p>}
        </div>
      ),
    },
    {
      content: (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Provider</Label>
            <div className="flex flex-wrap items-center gap-2">
              {["Github", "Gitlab", "Bitbucket", "Gitea", "Docker", "Git", "Drop"].map((p) => {
                const active = form.provider === p;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => set({ provider: active ? "" : p })}
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                      active ? "border-primary/50 bg-primary/10 text-primary" : "border-border/70 text-muted-foreground hover:border-border hover:bg-foreground/[0.05] hover:text-foreground",
                    )}
                  >
                    {active && <Check className="size-3" />}
                    {p}
                  </button>
                );
              })}
            </div>
          </div>

          {connectedGitAccount && (
            <div className="space-y-1.5">
              <Label>{gitKind[0].toUpperCase() + gitKind.slice(1)} Account</Label>
              <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-sm">
                <GitLogo type={gitKind as never} className="size-4" />
                <span className="font-medium text-foreground">{connectedGitAccount.name}</span>
                <span className="text-muted-foreground">· connected</span>
              </div>
            </div>
          )}

          {connectedGitAccount && reposQ.data?.items.length ? (
            <div className="space-y-1.5">
              <Label>Repository</Label>
              <CustomSelect
                value={form.repository}
                options={reposQ.data.items.map((r) => ({
                  value: r.url,
                  label: r.name,
                  description: `${r.private ? "private" : "public"}${r.defaultBranch ? ` · ${r.defaultBranch}` : ""}`,
                }))}
                onChange={(url) => set({ repository: url })}
                placeholder={reposQ.isFetching ? "Loading repositories…" : "Select a repository"}
              />
            </div>
          ) : null}

          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Label>Git repository URL</Label>
              <CircleHelp className="size-3.5 text-muted-foreground/60" />
            </div>
            <Input value={form.repository} onChange={(e) => set({ repository: e.target.value })} placeholder="https://github.com/org/repo.git" />
            <p className="text-[11px] text-muted-foreground">Pick from the list above or paste any public/private Git URL. Private repos clone with your connected account's token.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Branch</Label>
            <Input value={form.branch} onChange={(e) => set({ branch: e.target.value })} placeholder="main" />
          </div>
          <div>
            <Label className="mb-2 block">Deployment method</Label>
            <div className="grid grid-cols-2 gap-3">
              {(
                [
                  { key: "DOCKERFILE", label: "Dockerfile", desc: "Build from a Dockerfile and run a single container" },
                  { key: "COMPOSE", label: "Docker Compose", desc: "Deploy a multi-container stack from compose" },
                ] as const
              ).map((m) => (
                <button
                  key={m.key}
                  onClick={() => set({ deploymentMethod: m.key })}
                  className={cn(
                    "rounded-xl border p-4 text-start transition-colors",
                    form.deploymentMethod === m.key ? "border-primary bg-primary/[0.06]" : "border-border hover:bg-foreground/[0.05]",
                  )}
                >
                  <p className="text-sm font-medium">{m.label}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">{m.desc}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
      ),
    },
    {
      content:
        form.deploymentMethod === "DOCKERFILE" ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Dockerfile path</Label>
                <Input value={form.dockerfilePath} onChange={(e) => set({ dockerfilePath: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>Build context</Label>
                <Input value={form.buildContext} onChange={(e) => set({ buildContext: e.target.value })} placeholder="." />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Port</Label>
                <Input type="number" value={form.port} onChange={(e) => set({ port: e.target.value })} placeholder="3000" />
              </div>
              <div className="space-y-1.5">
                <Label>Start command (optional)</Label>
                <Input value={form.startCommand} onChange={(e) => set({ startCommand: e.target.value })} placeholder="node server.js" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Restart policy</Label>
              <CustomSelect
                value={form.restartPolicy}
                options={[
                  { value: "no", label: "no" },
                  { value: "always", label: "always" },
                  { value: "on-failure", label: "on-failure" },
                  { value: "unless-stopped", label: "unless-stopped" },
                ]}
                onChange={(v) => set({ restartPolicy: v })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>CPU limit (cores)</Label>
                <Input type="number" step="0.1" value={form.cpuLimit} onChange={(e) => set({ cpuLimit: e.target.value })} placeholder="1.0" />
              </div>
              <div className="space-y-1.5">
                <Label>Memory limit (MB)</Label>
                <Input type="number" value={form.memoryLimitBytes} onChange={(e) => set({ memoryLimitBytes: e.target.value })} placeholder="512" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Volume name (optional)</Label>
                <Input value={form.volumeName} onChange={(e) => set({ volumeName: e.target.value })} placeholder="nexus-app-data" />
              </div>
              <div className="space-y-1.5">
                <Label>Mount path</Label>
                <Input value={form.volumeMountPath} onChange={(e) => set({ volumeMountPath: e.target.value })} placeholder="/app/data" />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-xl border border-border/60 px-4 py-3">
              <div>
                <p className="text-sm font-medium">Health check</p>
                <p className="text-[11px] text-muted-foreground">HTTP probe against the app port</p>
              </div>
              <Switch checked={form.healthcheckEnabled} onChange={(v) => set({ healthcheckEnabled: v })} />
            </div>
            {form.healthcheckEnabled && (
              <div className="space-y-1.5">
                <Label>Health check path</Label>
                <Input value={form.healthcheckPath} onChange={(e) => set({ healthcheckPath: e.target.value })} placeholder="/health" />
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Compose file</Label>
              <Input value={form.composePath} onChange={(e) => set({ composePath: e.target.value })} placeholder="docker-compose.yml" />
              <p className="text-[11px] text-muted-foreground">Found at the repository root. Environment variables below are injected into the stack.</p>
            </div>
            <div className="flex items-center justify-between rounded-xl border border-border/60 px-4 py-3">
              <div>
                <p className="text-sm font-medium">Health check</p>
                <p className="text-[11px] text-muted-foreground">Probe one of the stack's published ports</p>
              </div>
              <Switch checked={form.healthcheckEnabled} onChange={(v) => set({ healthcheckEnabled: v })} />
            </div>
          </div>
        ),
    },
    {
      content: (
        <div className="space-y-4">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <Label>Environment variables</Label>
              <Button size="sm" variant="outline" onClick={() => setEnv([...env, { key: "", value: "", isSecret: false }])}>
                + Add
              </Button>
            </div>
            {env.length === 0 && <p className="rounded-xl border border-dashed border-border/70 px-4 py-4 text-center text-xs text-muted-foreground">No environment variables yet.</p>}
            <div className="space-y-2">
              {env.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input className="w-44 font-mono" value={row.key} onChange={(e) => setEnvRow(i, { key: e.target.value })} placeholder="KEY" />
                  <Input className="flex-1 font-mono" type={row.isSecret ? "password" : "text"} value={row.value} onChange={(e) => setEnvRow(i, { value: e.target.value })} placeholder="value" />
                  <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <Switch size="sm" checked={row.isSecret} onChange={(v) => setEnvRow(i, { isSecret: v })} /> secret
                  </label>
                  <button onClick={() => setEnv(env.filter((_, idx) => idx !== i))} className="shrink-0 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted">
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-border/60 bg-muted/40 p-4 text-sm">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Review</p>
            <div className="mt-2 space-y-1.5">
              <div className="flex justify-between"><span className="text-muted-foreground">Application</span><span className="font-medium">{form.name}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Server</span><span className="font-medium">{servers?.items.find((s) => s.id === form.serverId)?.name ?? form.serverId}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Method</span><span className="font-medium">{form.deploymentMethod}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Repository</span><span className="max-w-[60%] truncate font-medium">{form.repository}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Branch</span><span className="font-medium">{form.branch}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Port</span><span className="font-medium">{form.port || "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Environment</span><span className="font-medium">{env.filter((r) => r.key.trim()).length} variables</span></div>
            </div>
          </div>
        </div>
      ),
    },
  ];

  return (
    <div className="p-4 sm:p-6">
      <PageHeader title="New Application" description="Deploy a service from a Git repository to any server." />

      <div className={cn("grid items-start gap-6", createdAppId ? "lg:grid-cols-[minmax(0,1fr)_420px]" : "lg:grid-cols-[minmax(0,1fr)_400px]")}>
        <div>
          {/* Stepper */}
          <div className="mb-6 flex items-center gap-2">
            {STEPS.map((s, i) => (
              <div key={s.key} className="flex items-center gap-2">
                <button
                  onClick={() => i < step && setStep(i)}
                  className={cn(
                    "flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium transition-colors",
                    i === step ? "bg-primary text-primary-foreground" : i < step ? "text-primary hover:bg-primary/10" : "text-muted-foreground",
                  )}
                >
                  <s.icon className="size-3.5" />
                  <span className="hidden sm:inline">{s.label}</span>
                </button>
                {i < STEPS.length - 1 && <div className="h-px w-6 bg-border" />}
              </div>
            ))}
          </div>

          <Card className="max-w-2xl">
            <CardContent className="p-6">
              {steps[step]?.content}
              <div className="mt-6 flex items-center justify-between border-t border-border/60 pt-4">
                <Button variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
                  <ArrowLeft className="size-4" /> Back
                </Button>
                {step < steps.length - 1 ? (
                  <Button onClick={() => setStep((s) => s + 1)} disabled={!canNext}>
                    Next <ArrowRight className="size-4" />
                  </Button>
                ) : (
                  <Button onClick={deploy} disabled={creating}>
                    {creating ? <Loader2 className="size-4 animate-spin" /> : <Rocket className="size-4" />}
                    Create Application
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right column — live deployment logs after creation */}
        {createdAppId && (
          <div className="lg:sticky lg:top-6">
            <OperationLogPanel
              resourceType="application"
              resourceId={createdAppId}
              title="Deployment Logs"
              subtitle="Details of the request log entry."
            />
            <div className="mt-3">
              <p className="text-[11px] text-muted-foreground">Redirecting to the application…</p>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
