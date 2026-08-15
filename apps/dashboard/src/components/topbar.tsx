import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Bell, Search, ChevronRight, Server,
  Rocket, Database, Gamepad2, Archive, RotateCcw, CloudOff, Cloud, Wrench, AlertTriangle, Info,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { get, post } from "@/lib/api";
import { subscribeDashboard } from "@/lib/ws";
import { StatusDot } from "@/components/status-badge";
import { DismissiblePopover } from "@/components/ui/Popover";
import { timeAgo } from "@/lib/format";
import type { Server as ServerType } from "@nexus/types";

function Breadcrumbs() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const parts = pathname.split("/").filter(Boolean);
  const crumbs: { label: string; path: string }[] = [{ label: "NEXUS", path: "/overview" }];
  let acc = "";
  for (const part of parts) {
    acc += `/${part}`;
    const label = part.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
    crumbs.push({ label: decodeURIComponent(label), path: acc });
  }
  return (
    <nav className="flex items-center gap-1 text-[13px] text-muted-foreground" aria-label="Breadcrumb">
      {crumbs.map((c, i) => {
        const isLast = i === crumbs.length - 1;
        const isCurrent = c.path === pathname;
        return (
          <span key={`${c.path}-${i}`} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="size-3.5 text-muted-foreground/50" />}
            {isLast ? (
              <span className="truncate font-medium text-foreground" aria-current="page">
                {c.label}
              </span>
            ) : (
              <button
                onClick={() => navigate(c.path)}
                className={
                  isCurrent
                    ? "truncate rounded-md font-medium text-foreground"
                    : "truncate rounded-md transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                }
                title={c.path}
              >
                {c.label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

export function Topbar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const navigate = useNavigate();
  const [notifOpen, setNotifOpen] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);

  const { data: servers } = useQuery({ queryKey: ["servers"], queryFn: () => get<{ items: ServerType[] }>("/servers"), refetchInterval: 30000 });
  const online = servers?.items.filter((s) => s.status === "ONLINE").length ?? 0;
  const total = servers?.items.length ?? 0;

  const { data: notifs, refetch: refetchNotifs } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => get<{ items: { id: string; type: string; title: string; message: string; read: boolean; createdAt: string }[]; unread: number }>("/notifications"),
    refetchInterval: 30000,
  });

  // Real-time: mark notifications as they arrive.
  useEffect(() => {
    const unsub = subscribeDashboard((event) => {
      if (event.type === "notification") refetchNotifs();
      if (event.type === "server.status") refetchNotifs();
    });
    return unsub;
  }, [refetchNotifs]);

  const markRead = async (id: string) => {
    await post(`/notifications/${id}/read`).catch(() => {});
    refetchNotifs();
  };

  const notifStyle = (type: string): { icon: React.ReactNode; color: string } => {
    const cls = "size-4";
    if (type.startsWith("deployment.started")) return { icon: <Rocket className={cls} />, color: "text-sky-400" };
    if (type === "deployment.success") return { icon: <Rocket className={cls} />, color: "text-emerald-400" };
    if (type === "deployment.failed") return { icon: <AlertTriangle className={cls} />, color: "text-red-400" };
    if (type.startsWith("database.created")) return { icon: <Database className={cls} />, color: "text-indigo-400" };
    if (type === "application.created") return { icon: <Rocket className={cls} />, color: "text-violet-400" };
    if (type === "game.created") return { icon: <Gamepad2 className={cls} />, color: "text-fuchsia-400" };
    if (type.startsWith("database.backup")) return { icon: <Archive className={cls} />, color: "text-amber-400" };
    if (type === "backup.restored") return { icon: <RotateCcw className={cls} />, color: "text-emerald-400" };
    if (type === "server.online") return { icon: <Cloud className={cls} />, color: "text-emerald-400" };
    if (type === "server.offline") return { icon: <CloudOff className={cls} />, color: "text-red-400" };
    if (type === "server.install-failed") return { icon: <Wrench className={cls} />, color: "text-red-400" };
    if (type === "container.stopped") return { icon: <Server className={cls} />, color: "text-amber-400" };
    return { icon: <Info className={cls} />, color: "text-muted-foreground" };
  };

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center justify-between gap-4 border-b border-border/60 bg-background/80 px-6 backdrop-blur">
      <Breadcrumbs />

      <div className="flex items-center gap-1.5">
        <button
          onClick={onOpenPalette}
          className="flex h-9 items-center gap-2 rounded-xl border border-input bg-card px-3 text-[13px] text-muted-foreground transition-colors hover:border-ring/40 hover:text-foreground"
        >
          <Search className="size-3.5" />
          <span className="hidden sm:inline">Search</span>
          <kbd className="hidden rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium sm:inline">⌘K</kbd>
        </button>

        {/* Server status */}
        <button
          onClick={() => navigate("/servers")}
          className="flex h-9 items-center gap-2 rounded-xl border border-input bg-card px-3 text-[13px] text-muted-foreground transition-colors hover:border-ring/40 hover:text-foreground"
          title={`${online}/${total} servers online`}
        >
          <Server className="size-3.5" />
          <span className="tabular">{online}</span>
          <StatusDot status={online > 0 ? "ONLINE" : "OFFLINE"} />
          <span className="hidden lg:inline">{total} servers</span>
        </button>

        {/* Notifications */}
        <DismissiblePopover open={notifOpen} onOpenChange={setNotifOpen} className="relative">
          <button
            onClick={() => setNotifOpen((v) => !v)}
            className="relative flex size-9 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
            aria-label="Notifications"
          >
            <Bell className="size-4" />
            {(notifs?.unread ?? 0) > 0 && (
              <span className="absolute end-1.5 top-1.5 flex size-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-primary" />
              </span>
            )}
          </button>
          {notifOpen && (
            <div ref={notifRef} className="absolute end-0 top-11 z-50 w-80 overflow-hidden rounded-2xl border border-border/60 bg-popover shadow-xl shadow-black/[0.08]">
              <div className="flex items-center justify-between border-b border-border/50 px-4 py-3">
                <p className="text-sm font-semibold">Notifications</p>
                {notifs?.unread ? (
                  <button
                    onClick={async () => {
                      await post("/notifications/read-all").catch(() => {});
                      refetchNotifs();
                    }}
                    className="text-xs text-primary hover:underline"
                  >
                    Mark all read
                  </button>
                ) : null}
              </div>
              <div className="max-h-80 overflow-y-auto">
                {notifs?.items.length === 0 && <p className="px-4 py-8 text-center text-sm text-muted-foreground">No notifications</p>}
                {notifs?.items.slice(0, 20).map((n) => {
                  const s = notifStyle(n.type);
                  return (
                    <button
                      key={n.id}
                      onClick={() => markRead(n.id)}
                      className={`flex w-full items-start gap-3 border-b border-border/40 px-4 py-3 text-start transition-colors hover:bg-foreground/[0.06] ${n.read ? "" : "bg-primary/[0.04]"}`}
                    >
                      <span className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted/70 ${s.color}`}>
                        {s.icon}
                      </span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="block truncate text-[13px] font-medium text-foreground">{n.title}</span>
                          {!n.read && <span className="size-1.5 shrink-0 rounded-full bg-primary" />}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">{n.message}</span>
                        <span className="mt-0.5 block text-[11px] text-muted-foreground/70">{timeAgo(n.createdAt)}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </DismissiblePopover>
      </div>
    </header>
  );
}
