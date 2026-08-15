import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Loader2, Pencil, Trash2, PlugZap, CheckCircle2, XCircle } from "lucide-react";
import { get, post, patch, del } from "@/lib/api";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/toast";

type Provider = "github" | "gitlab" | "bitbucket" | "gitea";

interface GitProvider {
  id: string;
  provider: Provider;
  name: string;
  token: string; // masked
  createdAt: string;
  updatedAt: string;
}

const PROVIDERS: { key: Provider; label: string; hint: string; bg: string; fg: string; ring: string }[] = [
  { key: "github", label: "GitHub", hint: "Fine-grained or classic PAT with repo access", bg: "#1b1f24", fg: "#f5f5f5", ring: "#3d444d" },
  { key: "gitlab", label: "GitLab", hint: "Personal access token (read_repository, api)", bg: "#5b2d90", fg: "#ffffff", ring: "#7b3fc4" },
  { key: "bitbucket", label: "Bitbucket", hint: "App password or workspace access token", bg: "#0e5eff", fg: "#ffffff", ring: "#3d7bff" },
  { key: "gitea", label: "Gitea", hint: "Gitea access token (gitea.com or self-hosted)", bg: "#198754", fg: "#ffffff", ring: "#20a468" },
];

export function GitProvidersPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [modal, setModal] = useState<{ provider: Provider; editing: GitProvider | null } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["git-providers"],
    queryFn: () => get<{ items: GitProvider[] }>("/git-providers"),
  });

  const connected = data?.items ?? [];
  const connectedSet = new Set(connected.map((p) => p.provider));

  const invalidate = () => qc.invalidateQueries({ queryKey: ["git-providers"] });

  const remove = useMutation({
    mutationFn: (id: string) => del(`/git-providers/${id}`),
    onSuccess: () => {
      toast("success", "Git provider disconnected");
      invalidate();
    },
    onError: (e: Error) => toast("error", e.message),
  });

  return (
    <div className="p-6">
      <Card className="mx-auto max-w-3xl">
        <CardHeader className="p-6">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <GitBranch className="size-5" />
            </div>
            <div>
              <CardTitle className="text-base">Git Providers</CardTitle>
              <CardDescription className="mt-1">Connect your Git provider for authentication.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <div className="mx-6 h-px bg-border/60" />
        <CardContent className="p-6 pt-6">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          ) : connected.length === 0 ? (
            <div className="flex flex-col items-center py-14 text-center">
              <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <GitBranch className="size-5" />
              </div>
              <p className="text-sm font-semibold text-foreground">No Git Providers configured</p>
              <p className="mt-1.5 max-w-sm text-sm text-muted-foreground leading-relaxed">
                Connect a provider to let deployments clone private repositories during builds.
              </p>
            </div>
          ) : (
            <div className="mb-6 space-y-2">
              {connected.map((p) => {
                const meta = PROVIDERS.find((x) => x.key === p.provider)!;
                return (
                  <div key={p.id} className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/60 px-4 py-3 transition-colors hover:border-border">
                    <span
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold uppercase"
                      style={{ background: meta.bg, color: meta.fg }}
                    >
                      {meta.label.slice(0, 2)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-foreground">{p.name}</p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {meta.label} · token {p.token}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      title="Edit"
                      onClick={() => setModal({ provider: p.provider, editing: p })}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-destructive hover:text-destructive"
                      title="Disconnect"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(p.id)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="border-t border-border/50 pt-5">
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/70">
              {connected.length === 0 ? "Connect a provider" : "Add or reconnect a provider"}
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {PROVIDERS.map((p) => {
                const isConnected = connectedSet.has(p.key);
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => setModal({ provider: p.key, editing: null })}
                    className={`group flex flex-col items-center gap-2.5 rounded-xl border px-3 py-5 text-sm font-semibold transition-all duration-200 hover:-translate-y-0.5 ${
                      isConnected ? "border-border bg-card" : "border-border/60 bg-card/50"
                    }`}
                  >
                    <span
                      className="flex size-9 items-center justify-center rounded-lg text-[12px] font-bold uppercase shadow-sm transition-transform duration-200 group-hover:scale-110"
                      style={{ background: p.bg, color: p.fg, boxShadow: `0 0 0 1px ${p.ring}` }}
                    >
                      {p.label.slice(0, 2)}
                    </span>
                    <span className="flex items-center gap-1.5 text-foreground">
                      {p.label}
                      {isConnected && <CheckCircle2 className="size-3.5 text-success" />}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </CardContent>
      </Card>

      {modal && (
        <ConnectModal
          provider={modal.provider}
          editing={modal.editing}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            toast("success", modal.editing ? "Git provider updated" : "Git provider connected");
            invalidate();
          }}
          onError={(msg) => toast("error", msg)}
        />
      )}
    </div>
  );
}

function ConnectModal({
  provider,
  editing,
  onClose,
  onSaved,
  onError,
}: {
  provider: Provider;
  editing: GitProvider | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const meta = PROVIDERS.find((p) => p.key === provider)!;
  const [name, setName] = useState(editing?.name ?? "");
  const [token, setToken] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const testConnection = async () => {
    if (!token.trim()) {
      setTestResult({ ok: false, message: "Paste a personal access token first" });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await post<{ ok: boolean; account?: string; message?: string }>("/git-providers/test", {
        provider,
        token,
      });
      setTestResult({ ok: res.ok, message: res.ok ? `Connected as ${res.account ?? "account"}` : res.message });
      if (res.ok && res.account) setName((n) => n || res.account!);
    } catch (e) {
      setTestResult({ ok: false, message: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!token.trim() && !editing) return;
    setSaving(true);
    try {
      if (editing) {
        await patch(`/git-providers/${editing.id}`, { name: name.trim() || undefined, token: token.trim() || undefined });
      } else {
        await post("/git-providers", { provider, name: name.trim() || meta.label, token: token.trim() });
      }
      onSaved();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} width="440px" maxWidth="92vw">
      <div className="p-6">
        <div className="mb-6 flex items-center gap-3">
          <span
            className="flex size-10 items-center justify-center rounded-xl text-[13px] font-bold uppercase shadow-sm"
            style={{ background: meta.bg, color: meta.fg, boxShadow: `0 0 0 1px ${meta.ring}` }}
          >
            {meta.label.slice(0, 2)}
          </span>
          <div>
            <h2 className="text-base font-semibold text-foreground">
              {editing ? `Edit ${meta.label} account` : `Connect ${meta.label}`}
            </h2>
            <p className="text-xs text-muted-foreground">{meta.hint}</p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="gp-name">Account name</Label>
            <Input
              id="gp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={meta.label === "Gitea" ? "e.g. octocat" : "e.g. octocat"}
              autoComplete="off"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="gp-token">Personal access token {!editing && <span className="text-destructive">*</span>}</Label>
            <Input
              id="gp-token"
              type="password"
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                setTestResult(null);
              }}
              placeholder={editing ? "Leave empty to keep the current token" : "ghp_… / glpat-…"}
              autoComplete="new-password"
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Stored encrypted and only used by the agent to clone private repositories.
            </p>
          </div>

          {testResult && (
            <div
              className={`flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-sm ${
                testResult.ok ? "border-success/30 bg-success/10 text-success" : "border-destructive/30 bg-destructive/10 text-destructive"
              }`}
            >
              {testResult.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <XCircle className="mt-0.5 size-4 shrink-0" />}
              <span className="min-w-0 break-words">{testResult.message}</span>
            </div>
          )}
        </div>

        <div className="mt-7 flex items-center justify-end gap-2.5">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="outline" size="sm" onClick={testConnection} disabled={testing || !token.trim()}>
            {testing ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
            Test connection
          </Button>
          <Button size="sm" onClick={save} disabled={saving || (!editing && !token.trim())}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {editing ? "Save" : "Connect"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
