import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Plus, Loader2, Sparkles, Trash2, Gamepad2, Boxes } from "lucide-react";
import { get, post, del } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { PageHeader } from "@/components/page-header";
import { TableSkeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { CustomSelect } from "@/components/ui/custom-select";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/format";
import type { ApplicationWithExtras, Domain, GameServer, Server } from "@nexus/types";

/** Free wildcard DNS providers — <prefix>.<ip>.<domain> resolves to the IP. */
const FREE_PROVIDERS = [
  { id: "traefik.me", label: "Traefik.me", example: "my-app.192.168.1.10.traefik.me" },
  { id: "nip.io", label: "nip.io", example: "my-app.192.168.1.10.nip.io" },
  { id: "sslip.io", label: "sslip.io", example: "my-app.192.168.1.10.sslip.io" },
] as const;

type FreeProviderId = (typeof FREE_PROVIDERS)[number]["id"];

function buildFreeHostname(prefix: string, ip: string, provider: FreeProviderId): string {
  const cleanPrefix = prefix.trim().toLowerCase().replace(/[^a-z0-9.-]/g, "").replace(/^\\.+|\\.+$/g, "");
  const cleanIp = ip.trim();
  if (!cleanPrefix) return `${cleanIp}.${provider}`;
  return `${cleanPrefix}.${cleanIp}.${provider}`;
}

function AddDomainModal({
  apps,
  games,
  serverByHost,
  onClose,
  onAddingChange,
}: {
  apps: ApplicationWithExtras[];
  games: GameServer[];
  serverByHost: (serverId: string) => Server | undefined;
  onClose: () => void;
  onAddingChange?: (adding: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<"app" | "game">(apps.length ? "app" : "game");
  const [appId, setAppId] = useState(apps[0]?.id ?? "");
  const [gameId, setGameId] = useState(games[0]?.id ?? "");
  const [type, setType] = useState<"free" | "custom">("free");
  const [provider, setProvider] = useState<FreeProviderId>("traefik.me");
  const [prefix, setPrefix] = useState("");
  const [ip, setIp] = useState("");
  const [customHost, setCustomHost] = useState("");
  const [ssl, setSsl] = useState(false);
  const [adding, setAdding] = useState(false);

  const selectedApp = apps.find((a) => a.id === appId);
  const selectedGame = games.find((g) => g.id === gameId);
  const targetServer = target === "app" ? selectedApp?.server : serverByHost(selectedGame?.serverId ?? "");

  // Pre-fill the IP from the target's server host when it looks like an IP.
  useEffect(() => {
    const host = targetServer?.host ?? "";
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) setIp(host);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, appId, gameId]);

  const handleTargetChange = (next: "app" | "game") => {
    setTarget(next);
    const host = (next === "app" ? selectedApp?.server?.host : serverByHost(selectedGame?.serverId ?? "")?.host) ?? "";
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) setIp(host);
  };

  const freeHostname = useMemo(() => buildFreeHostname(prefix, ip, provider), [prefix, ip, provider]);
  const hostname = type === "free" ? freeHostname : customHost.trim();
  const resourceId = target === "app" ? appId : gameId;

  const add = async () => {
    if (!resourceId || !hostname) return;
    setAdding(true);
    onAddingChange?.(true);
    try {
      await post(
        target === "app" ? `/applications/${resourceId}/domains` : `/game-servers/${resourceId}/domains`,
        { hostname, sslEnabled: ssl },
      );
      toast("success", "Domain added", hostname);
      queryClient.invalidateQueries({ queryKey: ["all-domains"] });
      queryClient.invalidateQueries({ queryKey: ["application-detail"] });
      queryClient.invalidateQueries({ queryKey: ["game-server-detail"] });
      onClose();
    } catch (err) {
      toast("error", "Failed to add domain", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setAdding(false);
      onAddingChange?.(false);
    }
  };

  return (
    <div className="p-6">
      <h2 className="text-sm font-semibold">Add domain</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Attach a hostname to an application or game server. Use a free wildcard provider or your own custom domain.
      </p>

      <div className="mt-5 space-y-4">
        <div className="space-y-1.5">
          <Label>Target</Label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => apps.length && handleTargetChange("app")}
              disabled={!apps.length}
              className={cn(
                "flex items-center gap-2 rounded-xl border px-3 py-2.5 text-start text-sm transition-all duration-150 disabled:opacity-40",
                target === "app" ? "border-primary/60 bg-primary/10 text-foreground" : "border-border/60 text-muted-foreground hover:border-border",
              )}
            >
              <Boxes className={cn("size-4", target === "app" ? "text-primary" : "text-muted-foreground")} />
              Application
            </button>
            <button
              type="button"
              onClick={() => games.length && handleTargetChange("game")}
              disabled={!games.length}
              className={cn(
                "flex items-center gap-2 rounded-xl border px-3 py-2.5 text-start text-sm transition-all duration-150 disabled:opacity-40",
                target === "game" ? "border-primary/60 bg-primary/10 text-foreground" : "border-border/60 text-muted-foreground hover:border-border",
              )}
            >
              <Gamepad2 className={cn("size-4", target === "game" ? "text-primary" : "text-muted-foreground")} />
              Game server
            </button>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>{target === "app" ? "Application" : "Game server"}</Label>
          <CustomSelect
            value={target === "app" ? appId : gameId}
            options={
              target === "app"
                ? apps.map((a) => ({ value: a.id, label: a.name, description: a.server?.name ?? "no server" }))
                : games.map((g) => ({ value: g.id, label: g.name, description: serverByHost(g.serverId)?.name ?? "no server" }))
            }
            onChange={(v) => (target === "app" ? setAppId(v) : setGameId(v))}
            placeholder={target === "app" ? "Select an application" : "Select a game server"}
          />
        </div>

        <div className="space-y-1.5">
          <Label>Domain type</Label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setType("free")}
              className={cn(
                "flex items-center gap-2 rounded-xl border px-3 py-2.5 text-start text-sm transition-all duration-150",
                type === "free" ? "border-primary/60 bg-primary/10 text-foreground" : "border-border/60 text-muted-foreground hover:border-border",
              )}
            >
              <Sparkles className={cn("size-4", type === "free" ? "text-primary" : "text-muted-foreground")} />
              Free domain
            </button>
            <button
              type="button"
              onClick={() => setType("custom")}
              className={cn(
                "flex items-center gap-2 rounded-xl border px-3 py-2.5 text-start text-sm transition-all duration-150",
                type === "custom" ? "border-primary/60 bg-primary/10 text-foreground" : "border-border/60 text-muted-foreground hover:border-border",
              )}
            >
              <Globe className={cn("size-4", type === "custom" ? "text-primary" : "text-muted-foreground")} />
              Custom domain
            </button>
          </div>
        </div>

        {type === "free" ? (
          <>
            <div className="space-y-1.5">
              <Label>Provider</Label>
              <div className="grid grid-cols-3 gap-2">
                {FREE_PROVIDERS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setProvider(p.id)}
                    className={cn(
                      "rounded-xl border px-2 py-2 text-xs font-medium transition-all duration-150",
                      provider === p.id ? "border-primary/60 bg-primary/10 text-foreground" : "border-border/60 text-muted-foreground hover:border-border",
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Subdomain</Label>
                <Input
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  placeholder="my-server"
                  className="font-mono"
                  onKeyDown={(e) => e.key === "Enter" && void add()}
                />
              </div>
              <div className="space-y-1.5">
                <Label>IP address</Label>
                <Input
                  value={ip}
                  onChange={(e) => setIp(e.target.value)}
                  placeholder="192.168.1.10"
                  className="font-mono"
                  onKeyDown={(e) => e.key === "Enter" && void add()}
                />
              </div>
            </div>

            <div className="rounded-xl border border-dashed border-border/60 bg-muted/30 px-3.5 py-3">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Resulting hostname</p>
              <p className="mt-1 break-all font-mono text-sm text-foreground">
                {freeHostname || "—"}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {provider} resolves <span className="font-mono">{ip || "<ip>"}</span> automatically — no DNS setup needed.
              </p>
            </div>
          </>
        ) : (
          <div className="space-y-1.5">
            <Label>Hostname</Label>
            <Input
              value={customHost}
              onChange={(e) => setCustomHost(e.target.value)}
              placeholder="play.example.com"
              className="font-mono"
              onKeyDown={(e) => e.key === "Enter" && void add()}
            />
            <p className="text-[11px] text-muted-foreground">Point an A/AAAA record (or CNAME) to {targetServer?.host ?? "your server"}.</p>
          </div>
        )}

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch size="sm" checked={ssl} onChange={setSsl} /> Enable SSL (Let's Encrypt)
        </label>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onClose} disabled={adding}>Cancel</Button>
          <Button onClick={() => void add()} disabled={adding || !resourceId || !hostname}>
            {adding ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Add domain
          </Button>
        </div>
      </div>
    </div>
  );
}

type DomainRowItem = { domain: Domain; app?: ApplicationWithExtras; game?: GameServer };

export function DomainsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DomainRowItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const { data: apps } = useQuery({ queryKey: ["applications"], queryFn: () => get<{ items: ApplicationWithExtras[] }>("/applications", { limit: "200" }) });
  const { data: games } = useQuery({ queryKey: ["game-servers"], queryFn: () => get<{ items: GameServer[] }>("/game-servers", { limit: "200" }) });
  const { data: servers } = useQuery({ queryKey: ["servers"], queryFn: () => get<{ items: Server[] }>("/servers") });

  const serverById = useMemo(() => {
    const map = new Map<string, Server>();
    for (const s of servers?.items ?? []) map.set(s.id, s);
    return map;
  }, [servers]);
  const serverByHost = (serverId: string) => serverById.get(serverId);

  const { data: domainsByOwner, isLoading } = useQuery({
    queryKey: ["all-domains"],
    queryFn: async () => {
      const map = new Map<string, DomainRowItem[]>();
      for (const app of apps?.items ?? []) {
        const res = await get<{ items: Domain[] }>(`/applications/${app.id}/domains`).catch(() => ({ items: [] }));
        if (res.items.length) map.set(app.id, res.items.map((d) => ({ domain: d, app })));
      }
      for (const game of games?.items ?? []) {
        const res = await get<{ items: Domain[] }>(`/game-servers/${game.id}/domains`).catch(() => ({ items: [] }));
        if (res.items.length) map.set(game.id, res.items.map((d) => ({ domain: d, game })));
      }
      return map;
    },
    enabled: !!(apps?.items.length || games?.items.length),
  });

  const rows = useMemo(() => {
    const list: DomainRowItem[] = [];
    for (const [, items] of domainsByOwner ?? new Map()) {
      for (const item of items) {
        const ownerId = item.app?.id ?? item.game?.id;
        if (filter && ownerId !== filter) continue;
        list.push(item);
      }
    }
    return list;
  }, [domainsByOwner, filter]);

  const canAdd = !!(apps?.items.length || games?.items.length);

  const remove = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      if (deleteTarget.app) {
        await del(`/applications/${deleteTarget.app.id}/domains/${deleteTarget.domain.id}`);
      } else if (deleteTarget.game) {
        await del(`/game-servers/${deleteTarget.game.id}/domains/${deleteTarget.domain.id}`);
      }
      toast("success", "Domain removed", deleteTarget.domain.hostname);
      queryClient.invalidateQueries({ queryKey: ["all-domains"] });
      queryClient.invalidateQueries({ queryKey: ["application-detail"] });
      queryClient.invalidateQueries({ queryKey: ["game-server-detail"] });
      setDeleteTarget(null);
    } catch (err) {
      toast("error", "Remove failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setDeleting(false);
    }
  };

  const filterOptions = [
    { value: "", label: "All resources" },
    ...(apps?.items ?? []).map((a) => ({ value: a.id, label: `${a.name} (app)` })),
    ...(games?.items ?? []).map((g) => ({ value: g.id, label: `${g.name} (game)` })),
  ];

  return (
    <div className="p-6">
      <PageHeader
        title="Domains"
        description="Hostnames attached to applications and game servers — use a free wildcard domain or your own."
        actions={
          <div className="flex gap-2">
            {canAdd ? (
              <CustomSelect value={filter} options={filterOptions} onChange={(v) => setFilter(v)} className="w-64" />
            ) : undefined}
            <Button onClick={() => setAddOpen(true)} disabled={!canAdd}>
              <Plus className="size-4" /> Add domain
            </Button>
          </div>
        }
      />

      {isLoading ? (
        <TableSkeleton rows={6} cols={4} />
      ) : !rows.length ? (
        <EmptyState
          icon={<Globe className="size-5" />}
          title="No domains"
          description="Add a free wildcard domain (Traefik.me, nip.io, sslip.io) or a custom hostname to an application or game server."
          actionLabel="Add domain"
          onAction={() => canAdd && setAddOpen(true)}
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="divide-y divide-border/50">
            {rows.map(({ domain, app, game }) => {
              const isGame = !!game;
              const owner = app ?? game;
              return (
                <div key={domain.id} className="group flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-foreground/[0.05]">
                  <Link
                    to={app ? `/applications/${app.id}` : game ? `/game-servers/${game.id}` : "/"}
                    className="flex min-w-0 flex-1 items-center gap-4"
                  >
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                      {isGame ? <Gamepad2 className="size-4" /> : <Globe className="size-4" />}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{domain.hostname}</p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {owner?.name ?? "unknown"} · {isGame ? "game server" : "application"} · {domain.isPrimary ? "primary · " : ""}added {timeAgo(domain.createdAt)}
                      </p>
                    </div>
                  </Link>
                  <StatusBadge status={domain.sslStatus === "DISABLED" ? "DISABLED" : domain.sslStatus} className="shrink-0" />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDeleteTarget({ domain, app, game })}
                    className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {addOpen && canAdd ? (
        <Modal isOpen onClose={() => !addBusy && setAddOpen(false)} maxWidth="520px" showCloseButton={!addBusy}>
          <AddDomainModal
            apps={apps?.items ?? []}
            games={games?.items ?? []}
            serverByHost={serverByHost}
            onClose={() => setAddOpen(false)}
            onAddingChange={setAddBusy}
          />
        </Modal>
      ) : null}

      {deleteTarget && (
        <Modal isOpen onClose={() => !deleting && setDeleteTarget(null)} maxWidth="440px" showCloseButton={!deleting}>
          <div className="p-6">
            <h2 className="text-sm font-semibold">Remove domain</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {deleteTarget.domain.hostname} will no longer be attached to {(deleteTarget.app ?? deleteTarget.game)?.name}.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>Cancel</Button>
              <Button onClick={() => void remove()} disabled={deleting} variant="destructive">
                {deleting ? <Loader2 className="size-4 animate-spin" /> : null} Remove
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
