import { useEffect, useState } from "react";
import { Outlet, Navigate, useLocation } from "react-router-dom";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";
import { CommandPalette } from "@/components/command-palette";
import { useAuth } from "@/lib/auth";

export function AppLayout() {
  const { user, loading } = useAuth();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if (e.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span className="size-4 animate-spin rounded-full border-2 border-border border-t-primary" />
          Loading…
        </div>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;

  return (
    <div className="flex min-h-screen bg-background">
      {/* Desktop sidebar (>= lg) */}
      <div className="hidden shrink-0 lg:block">
        <Sidebar />
      </div>

      {/* Mobile drawer (< lg): slide-in sidebar over a backdrop */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-[60] lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={() => setSidebarOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-[272px] max-w-[85vw] shadow-2xl shadow-black/20">
            <Sidebar mobile onNavigate={() => setSidebarOpen(false)} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onOpenPalette={() => setPaletteOpen(true)} onOpenSidebar={() => setSidebarOpen(true)} />
        <main className="flex-1">
          <Outlet />
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
