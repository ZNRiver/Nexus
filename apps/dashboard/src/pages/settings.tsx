import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Settings as SettingsIcon, Loader2, ShieldCheck, Database, Activity, KeyRound, BellRing, Send, Webhook } from "lucide-react";
import { Switch } from "@/components/ui/Switch";
import { get, patch, post } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/skeleton";
import { useToast } from "@/components/toast";
import type { NexusSettings } from "@nexus/types";

export function SettingsPage() {
  const { toast } = useToast();
  const [form, setForm] = useState<NexusSettings | null>(null);
  const [saving, setSaving] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: ["settings"], queryFn: () => get<{ settings: NexusSettings }>("/settings") });

  useEffect(() => {
    if (data?.settings && !form) setForm(JSON.parse(JSON.stringify(data.settings)) as NexusSettings);
  }, [data, form]);

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      await patch("/settings", {
        instanceName: form.instanceName,
        retention: form.retention,
        monitoring: form.monitoring,
        security: form.security,
        notifications: form.notifications ?? {},
      });
      toast("success", "Settings saved", "Configuration updated");
    } catch (err) {
      toast("error", "Save failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  };

  if (isLoading || !form) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const set = <K extends keyof NexusSettings>(key: K, value: NexusSettings[K]) => setForm((f) => (f ? { ...f, [key]: value } : f));

  const setNotif = <K extends keyof NonNullable<NexusSettings["notifications"]>>(key: K, value: NonNullable<NexusSettings["notifications"]>[K]) =>
    setForm((f) => (f ? { ...f, notifications: { ...(f.notifications ?? {}), [key]: value } } : f));

  const testNotification = async () => {
    setSaving(true);
    try {
      await post("/settings/test-notification");
      toast("success", "Test sent", "Check your webhook / inbox for the test event");
    } catch (err) {
      toast("error", "Test failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-3xl p-6">
      <PageHeader title="Settings" description="Instance-wide configuration for NEXUS." />

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <SettingsIcon className="size-4 text-muted-foreground" /> General
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Instance name</Label>
              <Input value={form.instanceName} onChange={(e) => set("instanceName", e.target.value)} placeholder="NEXUS" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Database className="size-4 text-muted-foreground" /> Retention
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Keep last deployments</Label>
              <Input type="number" value={form.retention.deployments} onChange={(e) => set("retention", { ...form.retention, deployments: parseInt(e.target.value, 10) || 0 })} />
            </div>
            <div className="space-y-1.5">
              <Label>Deployment log retention (days)</Label>
              <Input type="number" value={form.retention.deploymentLogDays} onChange={(e) => set("retention", { ...form.retention, deploymentLogDays: parseInt(e.target.value, 10) || 0 })} />
            </div>
            <div className="space-y-1.5">
              <Label>Metrics retention (hours)</Label>
              <Input type="number" value={form.retention.metricsHours} onChange={(e) => set("retention", { ...form.retention, metricsHours: parseInt(e.target.value, 10) || 0 })} />
            </div>
            <div className="space-y-1.5">
              <Label>Audit log retention (days)</Label>
              <Input type="number" value={form.retention.auditLogDays} onChange={(e) => set("retention", { ...form.retention, auditLogDays: parseInt(e.target.value, 10) || 0 })} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Activity className="size-4 text-muted-foreground" /> Monitoring
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1.5">
              <Label>Agent metrics interval (seconds)</Label>
              <Input type="number" value={form.monitoring.intervalSeconds} onChange={(e) => set("monitoring", { ...form.monitoring, intervalSeconds: parseInt(e.target.value, 10) || 5 })} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldCheck className="size-4 text-muted-foreground" /> Security
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label>Session TTL (hours)</Label>
              <Input type="number" value={form.security.sessionTtlHours} onChange={(e) => set("security", { ...form.security, sessionTtlHours: parseInt(e.target.value, 10) || 24 })} />
            </div>
            <div className="space-y-1.5">
              <Label>Max failed logins</Label>
              <Input type="number" value={form.security.maxFailedLogins} onChange={(e) => set("security", { ...form.security, maxFailedLogins: parseInt(e.target.value, 10) || 5 })} />
            </div>
            <div className="space-y-1.5">
              <Label>Lockout (minutes)</Label>
              <Input type="number" value={form.security.lockoutMinutes} onChange={(e) => set("security", { ...form.security, lockoutMinutes: parseInt(e.target.value, 10) || 15 })} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <KeyRound className="size-4 text-muted-foreground" /> Container registry
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Registry</Label>
              <Input value={form.registry?.registry ?? ""} onChange={(e) => set("registry", { ...form.registry, registry: e.target.value })} placeholder="ghcr.io" />
            </div>
            <div className="space-y-1.5">
              <Label>Username</Label>
              <Input value={form.registry?.username ?? ""} onChange={(e) => set("registry", { ...form.registry, username: e.target.value })} placeholder="octocat" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <BellRing className="size-4 text-muted-foreground" /> Notifications
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 p-3">
              <div>
                <p className="text-sm font-medium">Backup events</p>
                <p className="text-xs text-muted-foreground">Notify when a scheduled backup completes or fails.</p>
              </div>
              <Switch checked={form.notifications?.backupEventsEnabled ?? false} onChange={(v) => setNotif("backupEventsEnabled", v)} ariaLabel="Backup events" />
            </div>

            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5">
                <Webhook className="size-3.5 text-muted-foreground" /> Webhook URL
              </Label>
              <Input
                value={form.notifications?.webhookUrl ?? ""}
                onChange={(e) => setNotif("webhookUrl", e.target.value)}
                placeholder="https://hooks.example.com/nexus"
                type="url"
              />
              <p className="text-[11px] text-muted-foreground">A JSON POST is sent to this URL for every backup event.</p>
            </div>

            <div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 p-3">
              <div>
                <p className="text-sm font-medium">Email</p>
                <p className="text-xs text-muted-foreground">Send backup events to an inbox via SMTP.</p>
              </div>
              <Switch checked={form.notifications?.emailEnabled ?? false} onChange={(v) => setNotif("emailEnabled", v)} ariaLabel="Email notifications" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>SMTP host</Label>
                <Input value={form.notifications?.smtpHost ?? ""} onChange={(e) => setNotif("smtpHost", e.target.value)} placeholder="smtp.gmail.com" />
              </div>
              <div className="space-y-1.5">
                <Label>SMTP port</Label>
                <Input
                  type="number"
                  value={form.notifications?.smtpPort ?? (form.notifications?.smtpSecure ? 465 : 587)}
                  onChange={(e) => setNotif("smtpPort", parseInt(e.target.value, 10) || (form.notifications?.smtpSecure ? 465 : 587))}
                />
              </div>
              <div className="space-y-1.5">
                <Label>SMTP user</Label>
                <Input value={form.notifications?.smtpUser ?? ""} onChange={(e) => setNotif("smtpUser", e.target.value)} placeholder="you@gmail.com" autoComplete="off" />
              </div>
              <div className="space-y-1.5">
                <Label>SMTP password / app token</Label>
                <Input type="password" value={form.notifications?.smtpPass ?? ""} onChange={(e) => setNotif("smtpPass", e.target.value)} placeholder="••••••••" autoComplete="new-password" />
              </div>
              <div className="space-y-1.5">
                <Label>From</Label>
                <Input value={form.notifications?.emailFrom ?? ""} onChange={(e) => setNotif("emailFrom", e.target.value)} placeholder="nexus@example.com" />
              </div>
              <div className="space-y-1.5">
                <Label>Recipients</Label>
                <Input value={form.notifications?.emailTo ?? ""} onChange={(e) => setNotif("emailTo", e.target.value)} placeholder="admin@example.com, dev@example.com" />
              </div>
              <div className="col-span-2 flex items-center gap-2">
                <Label className="flex items-center gap-1.5">
                  <ShieldCheck className="size-3.5 text-muted-foreground" /> Implicit TLS (port 465)
                </Label>
                <Switch checked={form.notifications?.smtpSecure ?? false} onChange={(v) => setNotif("smtpSecure", v)} ariaLabel="Implicit TLS" />
              </div>
            </div>

            <Button variant="outline" size="sm" onClick={testNotification} disabled={saving}>
              <Send className="size-3.5" /> Send test notification
            </Button>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null} Save settings
          </Button>
        </div>
      </div>
    </div>
  );
}
