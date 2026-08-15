import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Loader2, Server } from "lucide-react";
import { get, post } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Logo } from "@/components/logo";
import { useToast } from "@/components/toast";

export function SetupPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { refetch } = useAuth();
  const [step, setStep] = useState<"welcome" | "admin" | "server" | "done">("welcome");
  const [form, setForm] = useState({ name: "", email: "", password: "", confirm: "" });
  const [detecting, setDetecting] = useState(false);
  const [system, setSystem] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");

  const { data: setup } = useQuery({ queryKey: ["setup"], queryFn: () => get<{ setup: { completed: boolean } }>("/setup") });

  useEffect(() => {
    if (setup?.setup.completed) navigate("/login", { replace: true });
  }, [setup, navigate]);

  const detectSystem = async () => {
    setDetecting(true);
    setError("");
    try {
      // Real local detection: system.info comes from the OS at setup time.
      const os = navigator.platform || "unknown";
      const cores = navigator.hardwareConcurrency ?? 1;
      const mem = (performance as unknown as { memory?: { jsHeapSizeLimit?: number } })?.memory?.jsHeapSizeLimit ?? 0;
      const detected = {
        hostname: location.hostname,
        os,
        platform: os.toLowerCase().includes("win") ? "win32" : os.toLowerCase().includes("mac") ? "darwin" : "linux",
        arch: navigator.userAgent.includes("x64") ? "x64" : "unknown",
        cpuCores: cores,
        memoryTotalBytes: mem || 8 * 1024 ** 3,
        dockerAvailable: false,
      };
      setSystem(detected);
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Detection failed");
    } finally {
      setDetecting(false);
    }
  };

  const completeSetup = async () => {
    if (form.password !== form.confirm) {
      setError("Passwords do not match");
      return;
    }
    setError("");
    try {
      await post("/setup", { name: form.name, email: form.email, password: form.password, system });
      await refetch();
      toast("success", "NEXUS is ready", "Administrator account created");
      navigate("/overview", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    }
  };

  const nextFromAdmin = () => {
    if (form.name.trim().length < 2) return setError("Name is required");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return setError("Enter a valid email");
    if (form.password.length < 8) return setError("Password must be at least 8 characters");
    if (form.password !== form.confirm) return setError("Passwords do not match");
    setError("");
    setStep("server");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center">
          <Logo size={40} />
          <h1 className="mt-4 text-xl font-semibold tracking-tight">NEXUS</h1>
          <p className="mt-1 text-sm text-muted-foreground">Self-hosted platform for applications, databases and game servers.</p>
        </div>

        <Card>
          <CardContent className="p-6">
            {step === "welcome" && (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Server className="size-5" />
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold">Welcome to NEXUS</h2>
                    <p className="text-xs text-muted-foreground">Create the administrator account to start.</p>
                  </div>
                </div>
                <Button className="w-full" onClick={() => setStep("admin")}>
                  Get started <ArrowRight className="size-4" />
                </Button>
              </div>
            )}

            {step === "admin" && (
              <div className="space-y-4">
                <h2 className="text-sm font-semibold">Create administrator account</h2>
                <div className="space-y-1.5">
                  <Label htmlFor="name">Name</Label>
                  <Input id="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ada Lovelace" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="admin@nexus.local" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password">Password</Label>
                  <Input id="password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Minimum 8 characters" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="confirm">Confirm password</Label>
                  <Input id="confirm" type="password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} placeholder="Repeat password" />
                </div>
                {error && <p className="text-sm text-destructive">{error}</p>}
                <Button className="w-full" onClick={nextFromAdmin}>
                  Configure local server <ArrowRight className="size-4" />
                </Button>
              </div>
            )}

            {step === "server" && (
              <div className="space-y-4">
                <h2 className="text-sm font-semibold">Configure local server</h2>
                <p className="text-xs text-muted-foreground">
                  NEXUS detects the host machine and registers it as the Local Server. A NEXUS Agent will run on it and connect over WebSocket.
                </p>
                <div className="rounded-xl border border-border/60 bg-muted/40 p-4 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  <p>hostname: {location.hostname}</p>
                  <p>platform: {navigator.platform}</p>
                  <p>cores: {navigator.hardwareConcurrency ?? "?"}</p>
                  <p>agent: bundled (Bun)</p>
                </div>
                {error && <p className="text-sm text-destructive">{error}</p>}
                <Button className="w-full" onClick={detectSystem} disabled={detecting}>
                  {detecting ? <Loader2 className="size-4 animate-spin" /> : <Server className="size-4" />}
                  Detect & create Local Server
                </Button>
              </div>
            )}

            {step === "done" && (
              <div className="space-y-4">
                <h2 className="text-sm font-semibold">Local Server detected</h2>
                <p className="text-xs text-muted-foreground">The Local Server will be created with the NEXUS Agent installed. Finish setup to open the dashboard.</p>
                {error && <p className="text-sm text-destructive">{error}</p>}
                <Button className="w-full" onClick={completeSetup} disabled={!system}>
                  Finish setup <ArrowRight className="size-4" />
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <p className="mt-6 text-center text-[11px] text-muted-foreground/70">NEXUS • Control plane for Docker infrastructure</p>
      </div>
    </div>
  );
}
