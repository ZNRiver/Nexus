/**
 * External notification delivery (webhook + SMTP email).
 *
 * Reads the `notifications` block of the instance settings and dispatches
 * backup lifecycle events (scheduled backup completed / failed). Deliveries
 * are best-effort: failures are logged but never thrown so a broken webhook or
 * mail server can never break the backup flow itself.
 */
import { createLogger } from "@nexus/logger";
import type { BackupRow, DbConnection, ServerRow } from "@nexus/database";
import type { NexusSettings } from "@nexus/types";
import { SettingsService } from "./settings.service";
import { sendEmail } from "../lib/smtp";

const log = createLogger("api:notifier");

export type BackupEventType = "backup.completed" | "backup.failed";

export class NotifierService {
  constructor(
    private readonly db: DbConnection,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Notify that a backup finished (success or permanent failure). Resolves the
   * backup row and its resource/server from the DB, so callers only need the
   * backup id.
   */
  async notifyBackupResult(opts: { backupId: string; scheduled: boolean; error?: string }): Promise<void> {
    const settings = await this.settings.get();
    const notif = settings.notifications;
    if (!notif || notif.backupEventsEnabled === false) return;

    const backup = await this.db.get<BackupRow>(`SELECT * FROM backups WHERE id = ?`, [opts.backupId]);
    if (!backup) return;

    const resourceType: "DATABASE" | "APPLICATION" = backup.database_id ? "DATABASE" : "APPLICATION";
    const resourceId = backup.database_id ?? backup.application_id ?? "";
    const resource =
      resourceType === "DATABASE"
        ? await this.db.get<{ id: string; name: string }>(`SELECT id, name FROM databases WHERE id = ?`, [resourceId])
        : await this.db.get<{ id: string; name: string }>(`SELECT id, name FROM applications WHERE id = ?`, [resourceId]);
    const server = backup.server_id
      ? await this.db.get<ServerRow>(`SELECT * FROM servers WHERE id = ?`, [backup.server_id])
      : null;

    const event: BackupEventType = backup.status === "SUCCESS" ? "backup.completed" : "backup.failed";
    const payload = {
      event,
      timestamp: new Date().toISOString(),
      resource: { type: resourceType, id: resourceId, name: resource?.name ?? resourceId },
      backup: {
        id: backup.id,
        status: backup.status,
        sizeBytes: backup.size_bytes,
        error: opts.error ?? backup.error,
        scheduled: opts.scheduled,
        startedAt: backup.started_at,
        finishedAt: backup.finished_at,
      },
      server: server ? { id: server.id, name: server.name } : backup.server_id ? { id: backup.server_id, name: backup.server_id } : null,
      instance: settings.instanceName ?? "NEXUS",
    };

    if (notif.webhookUrl) {
      await this.sendWebhook(notif.webhookUrl, payload).catch((err) => {
        log.warn("webhook delivery failed", { event, backupId: backup.id, error: err instanceof Error ? err.message : String(err) });
      });
    }

    if (notif.emailEnabled && notif.smtpHost) {
      await this.sendEmail(event, backup, resource?.name ?? resourceId, settings).catch((err) => {
        log.warn("email delivery failed", { event, backupId: backup.id, error: err instanceof Error ? err.message : String(err) });
      });
    }
  }

  /** Deliver a test event through the configured channels. */
  async sendTestEvent(): Promise<{ webhook: boolean; email: boolean }> {
    const settings = await this.settings.get();
    const notif = settings.notifications;
    const payload = {
      event: "test",
      timestamp: new Date().toISOString(),
      resource: { type: "DATABASE", id: "test", name: "test-database" },
      backup: { id: "bak_test", status: "SUCCESS", sizeBytes: 123456, error: null, scheduled: true, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() },
      server: null,
      instance: settings.instanceName ?? "NEXUS",
    };
    const results = { webhook: false, email: false };
    if (notif?.webhookUrl) {
      await this.sendWebhook(notif.webhookUrl, payload);
      results.webhook = true;
    }
    if (notif?.emailEnabled && notif.smtpHost) {
      const to = (notif.emailTo ?? "").split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
      if (to.length === 0) throw new Error("No email recipients configured");
      await sendEmail({
        host: notif.smtpHost,
        port: notif.smtpPort ?? (notif.smtpSecure ? 465 : 587),
        secure: notif.smtpSecure ?? false,
        user: notif.smtpUser,
        pass: notif.smtpPass,
        from: notif.emailFrom || notif.smtpUser || "nexus@localhost",
        to,
        subject: `${settings.instanceName ?? "NEXUS"} — test notification`,
        text: "This is a test notification from NEXUS. If you can read this, email delivery is configured correctly.",
      });
      results.email = true;
    }
    return results;
  }

  private async sendWebhook(url: string, payload: unknown): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "NEXUS/0.1" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`webhook returned ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async sendEmail(
    event: BackupEventType,
    backup: Pick<BackupRow, "id" | "status" | "size_bytes" | "error" | "started_at" | "finished_at">,
    resourceName: string,
    settings: NexusSettings,
  ): Promise<void> {
    const notif = settings.notifications;
    if (!notif) return;
    const to = (notif.emailTo ?? "")
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (to.length === 0) throw new Error("No email recipients configured");
    const from = notif.emailFrom || notif.smtpUser || "nexus@localhost";
    const ok = event === "backup.completed";
    const subject = `${settings.instanceName ?? "NEXUS"} — backup ${ok ? "completed" : "FAILED"}: ${resourceName}`;
    const text = [
      `Backup ${ok ? "completed successfully" : "FAILED"}: ${resourceName}`,
      "",
      `Event:     ${event}`,
      `Backup:    ${backup.id}`,
      `Status:    ${backup.status}`,
      ok ? `Size:      ${backup.size_bytes != null ? `${Math.round(backup.size_bytes / 1024)} KB` : "unknown"}` : null,
      backup.error ? `Error:     ${backup.error}` : null,
      `Started:   ${backup.started_at ?? "—"}`,
      `Finished:  ${backup.finished_at ?? "—"}`,
      "",
      `Instance:  ${settings.instanceName ?? "NEXUS"}`,
    ]
      .filter((l): l is string => l !== null)
      .join("\n");

    await sendEmail({
      host: notif.smtpHost ?? "",
      port: notif.smtpPort ?? (notif.smtpSecure ? 465 : 587),
      secure: notif.smtpSecure ?? false,
      user: notif.smtpUser,
      pass: notif.smtpPass,
      from,
      to,
      subject,
      text,
    });
  }
}
