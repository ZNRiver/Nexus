import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Boxes,
  Database,
  Gamepad2,
  Rocket,
  Server,
  Container,
  Image as ImageIcon,
  HardDrive,
  Network,
  Activity,
  Globe,
  Archive,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  LogOut,
  Plus,
  Moon,
  Sun,
  SunMoon,
  ScrollText,
  Bell,
  FolderKanban,
  GitBranch,
} from "lucide-react";
import { Logo } from "@/components/logo";
import { useTheme } from "@/components/theme-provider";
import { post } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const NAV = [
  { section: null, items: [{ key: "overview", href: "/overview", icon: LayoutDashboard, label: "Overview" }] },
  {
    section: "Resources",
    items: [
      { key: "projects", href: "/projects", icon: FolderKanban, label: "Projects" },
      { key: "applications", href: "/applications", icon: Boxes, label: "Applications" },
      { key: "databases", href: "/databases", icon: Database, label: "Databases" },
      { key: "game-servers", href: "/game-servers", icon: Gamepad2, label: "Game Servers" },
      { key: "deployments", href: "/deployments", icon: Rocket, label: "Deployments" },
    ],
  },
  {
    section: "Infrastructure",
    items: [
      { key: "servers", href: "/servers", icon: Server, label: "Servers" },
      { key: "containers", href: "/containers", icon: Container, label: "Containers" },
      { key: "images", href: "/images", icon: ImageIcon, label: "Images" },
      { key: "volumes", href: "/volumes", icon: HardDrive, label: "Volumes" },
      { key: "networks", href: "/networks", icon: Network, label: "Networks" },
      { key: "monitoring", href: "/monitoring", icon: Activity, label: "Monitoring" },
    ],
  },
  {
    section: "Platform",
    items: [
      { key: "domains", href: "/domains", icon: Globe, label: "Domains" },
      { key: "git-providers", href: "/git-providers", icon: GitBranch, label: "Git Providers" },
      { key: "backups", href: "/backups", icon: Archive, label: "Backups" },
      { key: "jobs", href: "/jobs", icon: ScrollText, label: "Jobs" },
      { key: "audit", href: "/audit", icon: Bell, label: "Audit Log" },
    ],
  },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/overview") return pathname === "/overview" || pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

export function Sidebar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { user, refetch } = useAuth();
  const { resolvedTheme, toggle } = useTheme();
  const [collapsed, setCollapsed] = useState(false);

  const handleLogout = async () => {
    try {
      await post("/auth/logout");
    } catch {
      /* ignore */
    }
    refetch();
    navigate("/login");
  };

  return (
    <aside
      className={`sticky top-0 flex h-screen shrink-0 flex-col border-r border-border/60 bg-card/40 backdrop-blur transition-all duration-300 ease-in-out ${
        collapsed ? "w-[72px]" : "w-[248px]"
      }`}
    >
      {/* Header */}
      <div className={`flex items-center px-4 py-5 ${collapsed ? "flex-col gap-3" : "justify-between"}`}>
        <Link to="/overview" className="flex items-center gap-2.5 min-w-0" title="NEXUS">
          <Logo size={26} className="shrink-0" />
          {!collapsed && <span className="text-base font-semibold tracking-tight text-foreground">NEXUS</span>}
        </Link>
        <div className={`flex items-center ${collapsed ? "flex-col gap-1" : "gap-1"}`}>
          <button
            onClick={toggle}
            className="flex size-8 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
            aria-label="Toggle theme"
            title="Toggle theme"
          >
            {resolvedTheme === "light" ? <Sun className="size-4" /> : resolvedTheme === "dim" ? <SunMoon className="size-4" /> : <Moon className="size-4" />}
          </button>
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="flex size-8 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
          >
            {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          </button>
        </div>
      </div>
      <div className="mx-3 h-px bg-border/60" />

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-3 py-3">
        {NAV.map(({ section, items }, si) => (
          <div key={section ?? si} className={si > 0 ? "mt-5" : undefined}>
            {!collapsed && section && (
              <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">{section}</p>
            )}
            {collapsed && si > 0 && <div className="mx-2 my-3 h-px bg-border/60" />}
            <div className="space-y-1">
              {items.map(({ key, href, icon: Icon, label }) => {
                const active = isActive(pathname, href);
                return (
                  <Link
                    key={key}
                    to={href}
                    title={collapsed ? label : undefined}
                    className={`flex items-center rounded-xl px-3 py-2.5 text-[14px] font-medium transition-all duration-150 ring-inset ${
                      collapsed ? "justify-center" : "gap-3"
                    } ${
                      active
                        ? "bg-primary/10 text-primary ring-1 ring-primary/20"
                        : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground hover:ring-1 hover:ring-border/80"
                    }`}
                  >
                    <Icon className="size-[17px] shrink-0" strokeWidth={1.7} />
                    {!collapsed && <span className="flex-1 truncate">{label}</span>}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* CTA */}
      <div className="px-3 pb-2">
        <Link
          to="/applications/new"
          title={collapsed ? "New Application" : undefined}
          className="relative flex items-center justify-center gap-2.5 overflow-hidden rounded-xl border border-border/80 bg-foreground/[0.06] px-3 py-2.5 text-sm font-semibold text-foreground transition-colors hover:border-foreground/20 hover:bg-foreground/[0.1]"
        >
          <Plus className="size-4" strokeWidth={2.5} />
          {!collapsed && <span>New Application</span>}
        </Link>
      </div>

      {/* Account */}
      <div className="px-3 pb-4 pt-1">
        <div className="mx-2 mb-3 h-px bg-border/60" />
        {!collapsed && (
          <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">Account</p>
        )}
        <div className={`flex items-center rounded-xl px-2 py-2 ${collapsed ? "justify-center" : "gap-3"}`}>
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/[0.08] text-xs font-semibold uppercase text-foreground">
            {user?.name?.[0] ?? user?.email?.[0] ?? "?"}
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium leading-tight text-foreground">{user?.name}</p>
              <p className="truncate text-[11px] leading-tight text-muted-foreground">{user?.email}</p>
            </div>
          )}
          <button
            onClick={handleLogout}
            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
            aria-label="Log out"
            title="Log out"
          >
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
