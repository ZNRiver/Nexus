import type { DbConnection, SettingRow } from "@nexus/database";
import type { NexusSettings } from "@nexus/types";

export const DEFAULT_SETTINGS: NexusSettings = {
  instanceName: "NEXUS",
  retention: {
    deployments: 10,
    deploymentLogDays: 7,
    metricsHours: 24,
    auditLogDays: 90,
  },
  monitoring: {
    intervalSeconds: 10,
  },
  security: {
    sessionTtlHours: 168,
    maxFailedLogins: 10,
    lockoutMinutes: 15,
  },
};

export class SettingsService {
  constructor(private readonly db: DbConnection) {}

  private key = "settings";

  async get(): Promise<NexusSettings> {
    const row = await this.db.get<SettingRow>(`SELECT * FROM settings WHERE key = ?`, [this.key]);
    if (!row) return structuredClone(DEFAULT_SETTINGS);
    try {
      return { ...structuredClone(DEFAULT_SETTINGS), ...(JSON.parse(row.value) as Partial<NexusSettings>) };
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  async update(patch: Partial<NexusSettings>): Promise<NexusSettings> {
    const current = await this.get();
    const next = { ...current, ...patch, retention: { ...current.retention, ...patch.retention }, security: { ...current.security, ...patch.security }, monitoring: { ...current.monitoring, ...patch.monitoring } } as NexusSettings;
    await this.db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [this.key, JSON.stringify(next), new Date().toISOString()],
    );
    return next;
  }

  async getString(key: string): Promise<string | null> {
    const row = await this.db.get<SettingRow>(`SELECT * FROM settings WHERE key = ?`, [key]);
    return row?.value ?? null;
  }

  async setString(key: string, value: string): Promise<void> {
    await this.db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, new Date().toISOString()],
    );
  }
}
