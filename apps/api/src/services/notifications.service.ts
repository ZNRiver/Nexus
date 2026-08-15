import type { DbConnection, NotificationRow } from "@nexus/database";
import { newId } from "../lib/crypto";
import { eventHub } from "../lib/events";
import type { NotificationType } from "@nexus/types";

export class NotificationsService {
  constructor(private readonly db: DbConnection) {}

  async create(userId: string, type: NotificationType, title: string, message: string): Promise<void> {
    const row: NotificationRow = {
      id: newId("ntf"),
      user_id: userId,
      type,
      title,
      message,
      read: 0,
      created_at: new Date().toISOString(),
    };
    await this.db.run(
      `INSERT INTO notifications (id, user_id, type, title, message, read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.user_id, row.type, row.title, row.message, row.read, row.created_at],
    );
    eventHub.emit({
      type: "notification",
      notification: {
        id: row.id,
        userId: row.user_id,
        type: type as NotificationType,
        title,
        message,
        read: false,
        createdAt: row.created_at,
      },
    });
  }

  async listForUser(userId: string, limit = 50): Promise<NotificationRow[]> {
    return this.db.all<NotificationRow>(
      `SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
      [userId, limit],
    );
  }

  async unreadCount(userId: string): Promise<number> {
    const row = await this.db.get<{ c: number }>(
      `SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND read = 0`,
      [userId],
    );
    return Number(row?.c ?? 0);
  }

  async markRead(userId: string, id: string): Promise<void> {
    await this.db.run(`UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?`, [id, userId]);
  }

  async markAllRead(userId: string): Promise<void> {
    await this.db.run(`UPDATE notifications SET read = 1 WHERE user_id = ?`, [userId]);
  }
}
