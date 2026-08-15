import { createLogger } from "@nexus/logger";
import type { JobRow } from "@nexus/database";
import type { JobStatus, JobType } from "@nexus/types";
import type { AppContext } from "../context";
import { JobQueue } from "./queue";
import { eventHub } from "../lib/events";

const log = createLogger("api:worker");

type JobHandler = (job: JobRow) => Promise<void>;

/**
 * Background worker. Runs in-process with the API (Bun is single-threaded but
 * the work is async I/O bound: SSH, Docker, git). Jobs are claimed atomically
 * from the jobs table so a second API instance can safely share the queue.
 */
export class Worker {
  private running = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private handlers = new Map<string, JobHandler>();

  constructor(private readonly ctx: AppContext) {}

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => void this.tick(), 1000);
    log.info("worker started", { handlers: [...this.handlers.keys()] });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.running = false;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const queue = new JobQueue(this.ctx.db);
    try {
      const job = await queue.claimNext();
      if (!job) return;
      void this.process(queue, job);
    } catch (err) {
      log.error("worker tick failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async process(queue: JobQueue, job: JobRow): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (!handler) {
      await queue.fail(job.id, `No handler for job type ${job.type}`, { attempts: job.attempts, maxAttempts: job.max_attempts });
      return;
    }
    try {
      // payload is stored as JSON text — parse it before handing to the handler.
      let parsedPayload: Record<string, unknown> = {};
      try {
        parsedPayload = JSON.parse(job.payload) as Record<string, unknown>;
      } catch {
        parsedPayload = {};
      }
      await handler({ ...job, payload: parsedPayload } as never);
      await queue.complete(job.id);
      let successPayload: Record<string, unknown> = {};
      try {
        successPayload = JSON.parse(job.payload) as Record<string, unknown>;
      } catch {
        successPayload = {};
      }
      eventHub.emit({ type: "job.status", job: { id: job.id, type: job.type as JobType, status: "SUCCESS", attempts: job.attempts, maxAttempts: job.max_attempts, payload: successPayload, error: null, createdAt: job.created_at, startedAt: job.started_at, finishedAt: new Date().toISOString() } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = (err as { retryable?: boolean }).retryable === true;
      await queue.fail(job.id, message, { retryable, attempts: job.attempts, maxAttempts: job.max_attempts });
      const finalJob = await this.ctx.db.get<JobRow>(`SELECT * FROM jobs WHERE id = ?`, [job.id]);
      let failedPayload: Record<string, unknown> = {};
      try {
        failedPayload = JSON.parse(job.payload) as Record<string, unknown>;
      } catch {
        failedPayload = {};
      }
      eventHub.emit({ type: "job.status", job: { id: job.id, type: job.type as JobType, status: (finalJob?.status ?? "FAILED") as JobStatus, attempts: finalJob?.attempts ?? job.attempts, maxAttempts: finalJob?.max_attempts ?? job.max_attempts, payload: failedPayload, error: message, createdAt: job.created_at, startedAt: job.started_at, finishedAt: finalJob?.finished_at ?? null } });
      // A scheduled backup job that failed permanently (retries exhausted or a
      // non-retryable error) should also mark the backup row FAILED — the
      // handler only marks it FAILED for errors inside its own try block.
      if (finalJob?.status === "FAILED" && (job.type === "database-backup" || job.type === "application-backup")) {
        const backupId = String(failedPayload.backupId ?? "");
        if (backupId) {
          await this.ctx.db.run(
            `UPDATE backups SET status = 'FAILED', error = ?, finished_at = ? WHERE id = ? AND status != 'SUCCESS'`,
            [message, new Date().toISOString(), backupId],
          ).catch(() => {});
        }
        // Notify externally (webhook/email) when the failed backup was scheduled.
        if (failedPayload.scheduled === true && backupId) {
          try {
            const { NotifierService } = await import("../services/notifier.service");
            const { SettingsService } = await import("../services/settings.service");
            await new NotifierService(this.ctx.db, new SettingsService(this.ctx.db)).notifyBackupResult({ backupId, scheduled: true, error: message });
          } catch (err) {
            log.warn("backup failure notification failed", { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
          }
        }
      }
      if (!retryable) {
        log.error("job failed", { jobId: job.id, type: job.type, error: message });
      }
    }
  }
}
