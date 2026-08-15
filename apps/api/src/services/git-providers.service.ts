import type { AppContext } from "../context";
import { encrypt, decrypt, newId } from "../lib/crypto";
import { errors } from "../lib/errors";

export type GitProviderType = "github" | "gitlab" | "bitbucket" | "gitea";

export const GIT_PROVIDERS: GitProviderType[] = ["github", "gitlab", "bitbucket", "gitea"];

/**
 * Resolve which connected provider should authenticate a repository.
 * Accepts the stored provider value (e.g. "Github") case-insensitively and
 * falls back to inferring the provider from the repository URL when the
 * provider was never set on the application.
 */
export function normalizeGitProvider(provider: string | null | undefined, repository?: string | null): GitProviderType | null {
  const p = (provider ?? "").toLowerCase();
  if ((GIT_PROVIDERS as string[]).includes(p)) return p as GitProviderType;
  const u = (repository ?? "").toLowerCase();
  if (u.includes("github")) return "github";
  if (u.includes("gitlab")) return "gitlab";
  if (u.includes("bitbucket")) return "bitbucket";
  if (u.includes("gitea")) return "gitea";
  return null;
}

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

/** Repository list endpoints — same auth style as TEST_ENDPOINTS. */
const REPO_ENDPOINTS: Record<GitProviderType, { url: string; headers: (token: string) => Record<string, string> }> = {
  github: { url: "https://api.github.com/user/repos?per_page=100&sort=updated", headers: (t) => ({ Authorization: `Bearer ${t}`, "User-Agent": "nexus" }) },
  gitlab: { url: "https://gitlab.com/api/v4/projects?membership=true&per_page=100&simple=true", headers: (t) => ({ "PRIVATE-TOKEN": t }) },
  bitbucket: { url: "https://api.bitbucket.org/2.0/repositories?role=member&pagelen=100", headers: (t) => ({ Authorization: `Basic ${Buffer.from(`x-token-auth:${t}`).toString("base64")}` }) },
  gitea: { url: "https://gitea.com/api/v1/user/repos?limit=100", headers: (t) => ({ Authorization: `token ${t}` }) },
};

export interface GitRepo {
  name: string;
  url: string;
  private: boolean;
  defaultBranch: string | null;
}

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
  /**
   * List the connected account's repositories using the stored token.
   * Returns a normalized list with clone URLs ready for deployments.
   */
  async listRepos(provider: GitProviderType): Promise<GitRepo[]> {
    const token = await this.tokenFor(provider);
    if (!token) throw errors.notFound(`No ${provider} account connected — connect it in Git Providers first`);
    const ep = REPO_ENDPOINTS[provider];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(ep.url, { headers: ep.headers(token), signal: controller.signal });
      if (!res.ok) throw errors.serverError(`Could not list ${provider} repositories (HTTP ${res.status})`);
      const body = await res.json().catch(() => ({})) as never;
      return normalizeRepos(provider, body);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw errors.serverError(`Timed out talking to ${provider}`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

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

function normalizeRepos(provider: GitProviderType, body: never): GitRepo[] {
  if (provider === "bitbucket") {
    const values = (body as { values?: { full_name?: string; is_private?: boolean; mainbranch?: { name?: string } | null; clone?: { name?: string; href?: string }[] }[] }).values ?? [];
    return values.map((v) => {
      const httpsClone = (v.clone ?? []).find((c) => c.name === "https");
      return {
        name: v.full_name ?? "",
        url: httpsClone?.href ?? "",
        private: !!v.is_private,
        defaultBranch: v.mainbranch?.name ?? null,
      };
    }).filter((r) => r.name && r.url);
  }
  const list = (body as { full_name?: string; clone_url?: string; http_url_to_repo?: string; private?: boolean; visibility?: string; default_branch?: string | null }[]);
  return list.map((r) => ({
    name: r.full_name ?? r.http_url_to_repo ?? "",
    url: r.clone_url ?? r.http_url_to_repo ?? "",
    private: !!r.private || (r.visibility ?? "") === "private",
    defaultBranch: r.default_branch ?? null,
  })).filter((r) => r.name && r.url);
}

function maskToken(encrypted: string): string {
  if (!encrypted) return "";
  const raw = encrypted.startsWith("enc:v1:") ? encrypted : encrypted;
  const len = raw.length;
  if (len <= 8) return "•".repeat(len);
  return `${raw.slice(0, 2)}${"•".repeat(10)}${raw.slice(-2)}`;
}
