import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Boxes, Database, Search, Server as ServerIcon, Rocket, Settings, FolderKanban, Gamepad2, Command } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/input";
import { get } from "@/lib/api";
import type { SearchResults } from "@nexus/types";

const ACTIONS = [
  { label: "Create Application", icon: Boxes, run: (n: (p: string) => void) => n("/applications/new") },
  { label: "Create Database", icon: Database, run: (n: (p: string) => void) => n("/databases/new") },
  { label: "Add Server", icon: ServerIcon, run: (n: (p: string) => void) => n("/servers?new=1") },
  { label: "Create Project", icon: FolderKanban, run: (n: (p: string) => void) => n("/projects?new=1") },
  { label: "Create Game Server", icon: Gamepad2, run: (n: (p: string) => void) => n("/game-servers/new") },
  { label: "Deployments", icon: Rocket, run: (n: (p: string) => void) => n("/deployments") },
  { label: "Settings", icon: Settings, run: (n: (p: string) => void) => n("/settings") },
];

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setResults(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setResults(null);
      return;
    }
    const timer = setTimeout(() => {
      get<SearchResults>("/search", { q: query.trim() })
        .then(setResults)
        .catch(() => setResults(null));
    }, 150);
    return () => clearTimeout(timer);
  }, [query, open]);

  const filteredActions = useMemo(
    () => ACTIONS.filter((a) => a.label.toLowerCase().includes(query.toLowerCase())),
    [query],
  );

  const run = (fn: (n: (p: string) => void) => void) => {
    onClose();
    fn(navigate);
  };

  const go = (path: string) => {
    onClose();
    navigate(path);
  };

  return (
    <Modal isOpen={open} onClose={onClose} maxWidth="560px" showCloseButton={false}>
      <div className="p-3">
        <div className="relative">
          <Search className="absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search resources or run a command…" className="ps-10" />
        </div>

        <div className="mt-3 max-h-[360px] overflow-y-auto">
          {filteredActions.length > 0 && (
            <>
              <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">Actions</p>
              {filteredActions.map((a) => (
                <button
                  key={a.label}
                  onClick={() => run(a.run)}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start text-sm hover:bg-foreground/[0.06]"
                >
                  <a.icon className="size-4 text-muted-foreground" />
                  <span className="font-medium">{a.label}</span>
                </button>
              ))}
            </>
          )}

          {results && (results.applications.length > 0 || results.servers.length > 0 || results.databases.length > 0) && (
            <>
              <p className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">Resources</p>
              {results.applications.map((a) => (
                <button key={a.id} onClick={() => go(`/applications/${a.id}`)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-start text-sm hover:bg-foreground/[0.06]">
                  <Boxes className="size-4 text-muted-foreground" />
                  <span className="font-medium">{a.name}</span>
                  <span className="ms-auto text-xs text-muted-foreground">Application</span>
                </button>
              ))}
              {results.servers.map((s) => (
                <button key={s.id} onClick={() => go(`/servers/${s.id}`)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-start text-sm hover:bg-foreground/[0.06]">
                  <ServerIcon className="size-4 text-muted-foreground" />
                  <span className="font-medium">{s.name}</span>
                  <span className="ms-auto text-xs text-muted-foreground">Server</span>
                </button>
              ))}
              {results.databases.map((d) => (
                <button key={d.id} onClick={() => go(`/databases/${d.id}`)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-start text-sm hover:bg-foreground/[0.06]">
                  <Database className="size-4 text-muted-foreground" />
                  <span className="font-medium">{d.name}</span>
                  <span className="ms-auto text-xs text-muted-foreground">Database</span>
                </button>
              ))}
            </>
          )}

          {query.trim().length >= 2 && filteredActions.length === 0 && !results && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">Searching…</p>
          )}
          {query.trim().length >= 2 && filteredActions.length === 0 && results && results.applications.length === 0 && results.servers.length === 0 && results.databases.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">No results for “{query}”</p>
          )}
        </div>

        <div className="mt-2 flex items-center gap-2 border-t border-border/60 px-2 pt-2 text-[11px] text-muted-foreground">
          <Command className="size-3" /> ⌘K to toggle
        </div>
      </div>
    </Modal>
  );
}
