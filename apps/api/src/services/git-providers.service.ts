import type { AppContext } from "../context";
import { encrypt, decrypt, newId } from "../lib/crypto";
import { errors } from "../lib/errors";

export type GitProviderType = "github" | "gitlab" | "bitbucket" | "gitea";

export const GIT_PROVIDERS: GitProviderType[] = ["github", "gitlab", "bitbucket", "gitea"];

export interface GitProviderRow {
  id: string;
  provider: GitProviderType;
  name: string;
  token_encrypted: string;
  created_at: string;
  updated_at: string;
}

export interface GitProviderPublic {
  id: string;
  provider: GitProviderType;
  name: string;
  /** masked token — the raw token is never exposed by the API */
  token: string;
  createdAt: string;
  updatedAt: string;
}

/** Base URLs used to verify a personal access token against each provider. */
const TEST_ENDPOINTS: Record<GitProviderType, { url: string; headers: (token: string) => Record<string, string> }> = {
  github: { url: "https://api.github.com/user", headers: (t) => ({ Authorization: `Bearer ${t}` }) },
  gitlab: { url: "https://gitlab.com/api/v4/user", headers: (t) => ({ "PRIVATE-TOKEN": t }) },
  bitbucket: { url: "https://api.bitbucket.org/2.0/user", headers: (t) => ({ Authorization: `Basic ${Buffer.from(`x-token-auth:${t}`).toString("base64")}` }) },
  gitea: { url: "https://gitea.com/api/v1/user", headers: (t) => ({ Authorization: `token ${t}` }) },
};

export class GitProvidersService {
  constructor(
    private readonly ctx: AppContext,
  ) {}

  private map(row: GitProviderRow): GitProviderPublic {
    return {
      id: row.id,
      provider: row.provider,
      name: row.name,
      token: maskToken(row.token_encrypted),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async list(): Promise<GitProviderPublic[]> {
    const rows = await this.ctx.db.all<GitProviderRow>(`SELECT * FROM git_providers ORDER BY created_at ASC`);
    return rows.map((r) => this.map(r));
  }

  async getByProvider(provider: GitProviderType): Promise<GitProviderRow | null> {
    return this.ctx.db.get<GitProviderRow>(`SELECT * FROM git_providers WHERE provider = ?`, [provider]);
  }

  /** Decrypted token for a provider — used only inside the API (never sent to the browser). */
  async tokenFor(provider: GitProviderType): Promise<string | null> {
    const row = await this.getByProvider(provider);
    if (!row) return null;
    return decrypt(row.token_encrypted, this.ctx.config.encryptionKey);
  }

  async create(input: { provider: GitProviderType; name: string; token: string }): Promise<GitProviderPublic> {
    const provider = input.provider;
    if (!GIT_PROVIDERS.includes(provider)) throw errors.validation({ provider: "Unknown provider" });
    const existing = await this.getByProvider(provider);
    if (existing) throw errors.validation({ provider: `A ${provider} account is already connected — edit it instead` });
    const now = new Date().toISOString();
    const id = newId("gp");
    const tokenEncrypted = encrypt(input.token.trim(), this.ctx.config.encryptionKey);
    await this.ctx.db.run(
      `INSERT INTO git_providers (id, provider, name, token_encrypted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, provider, input.name.trim() || provider, tokenEncrypted, now, now],
    );
    const row = await this.ctx.db.get<GitProviderRow>(`SELECT * FROM git_providers WHERE id = ?`, [id]);
    return this.map(row!);
  }

  async update(id: string, patch: { name?: string; token?: string }): Promise<GitProviderPublic> {
    const row = await this.ctx.db.get<GitProviderRow>(`SELECT * FROM git_providers WHERE id = ?`, [id]);
    if (!row) throw errors.notFound("Git provider not found");
    const now = new Date().toISOString();
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) {
      sets.push("name = ?");
      params.push(patch.name.trim() || row.provider);
    }
    if (patch.token !== undefined && patch.token.trim()) {
      sets.push("token_encrypted = ?");
      params.push(encrypt(patch.token.trim(), this.ctx.config.encryptionKey));
    }
    if (sets.length === 0) return this.map(row);
    sets.push("updated_at = ?");
    params.push(now);
    params.push(id);
    await this.ctx.db.run(`UPDATE git_providers SET ${sets.join(", ")} WHERE id = ?`, params);
    const updated = await this.ctx.db.get<GitProviderRow>(`SELECT * FROM git_providers WHERE id = ?`, [id]);
    return this.map(updated!);
  }

  async remove(id: string): Promise<void> {
    const row = await this.ctx.db.get<GitProviderRow>(`SELECT * FROM git_providers WHERE id = ?`, [id]);
    if (!row) throw errors.notFound("Git provider not found");
    await this.ctx.db.run(`DELETE FROM git_providers WHERE id = ?`, [id]);
  }

  /**
   * Verify a personal access token against the provider's API. Returns the
   * account handle/name reported by the provider (e.g. `octocat`) or null when
   * the token is invalid / the provider is unreachable.
   */
  async testToken(provider: GitProviderType, token: string): Promise<{ ok: boolean; account?: string; message?: string }> {
    if (!GIT_PROVIDERS.includes(provider)) return { ok: false, message: "Unknown provider" };
    const ep = TEST_ENDPOINTS[provider];
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(ep.url, { headers: ep.headers(token.trim()), signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        return { ok: false, message: `Token rejected (HTTP ${res.status})` };
      }
      const body = (await res.json().catch(() => ({}))) as { login?: string; username?: string; display_name?: string; full_name?: string };
      const account = body.login ?? body.username ?? body.display_name ?? body.full_name ?? null;
      return account ? { ok: true, account } : { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Could not reach ${provider} (${message})` };
    }
  }
}

function maskToken(encrypted: string): string {
  if (!encrypted) return "";
  const raw = encrypted.startsWith("enc:v1:") ? encrypted : encrypted;
  const len = raw.length;
  if (len <= 8) return "•".repeat(len);
  return `${raw.slice(0, 2)}${"•".repeat(10)}${raw.slice(-2)}`;
}
