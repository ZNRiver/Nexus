import { z } from "zod";
import type { AppContext } from "../context";
import type { App } from "../types";
import { GitProvidersService } from "../services/git-providers.service";
import { requireAuth, requirePermission } from "../middleware/auth";
import { errors } from "../lib/errors";
import { pid } from "../lib/http";

const providerEnum = z.enum(["github", "gitlab", "bitbucket", "gitea"]);

const providerSchema = z.object({
  provider: providerEnum,
  name: z.string().min(1).optional(),
  token: z.string().min(1, "Personal access token is required"),
});

const testSchema = z.object({
  provider: providerEnum,
  token: z.string().min(1),
});

export function registerGitProviderRoutes(app: App, ctx: AppContext): void {
  const providers = new GitProvidersService(ctx);

  /* ── git providers (GitHub / GitLab / Bitbucket / Gitea) ─────── */

  app.get("/api/v1/git-providers", requireAuth, requirePermission("settings.read"), async (c) => {
    const items = await providers.list();
    return c.json({ success: true, items });
  });

  app.post("/api/v1/git-providers", requireAuth, requirePermission("settings.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = providerSchema.safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const provider = await providers.create(parsed.data as never);
    await ctx.audit({ action: "git-provider.create", resourceType: "git_provider", resourceName: provider.name, metadata: { provider: provider.provider } });
    return c.json({ success: true, provider });
  });

  app.post("/api/v1/git-providers/test", requireAuth, requirePermission("settings.read"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = testSchema.safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const result = await providers.testToken(parsed.data.provider, parsed.data.token);
    return c.json({ success: result.ok, ...result });
  });

  app.get("/api/v1/git-providers/:provider/repos", requireAuth, requirePermission("settings.read"), async (c) => {
    const provider = (c.req.param("provider") ?? "").toLowerCase() as never;
    if (!["github", "gitlab", "bitbucket", "gitea"].includes(provider)) throw errors.validation({ provider: "Unknown provider" });
    const items = await providers.listRepos(provider);
    return c.json({ success: true, items });
  });

  app.patch("/api/v1/git-providers/:id", requireAuth, requirePermission("settings.write"), async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ name: z.string().min(1).optional(), token: z.string().min(1).optional() }).safeParse(body);
    if (!parsed.success) throw errors.validation(parsed.error.flatten());
    const provider = await providers.update(pid(c), parsed.data);
    await ctx.audit({ action: "git-provider.update", resourceType: "git_provider", resourceId: provider.id, resourceName: provider.name });
    return c.json({ success: true, provider });
  });

  app.delete("/api/v1/git-providers/:id", requireAuth, requirePermission("settings.write"), async (c) => {
    const id = pid(c);
    const provider = await providers.list().then((items) => items.find((p) => p.id === id));
    await providers.remove(id);
    await ctx.audit({ action: "git-provider.delete", resourceType: "git_provider", resourceId: id, resourceName: provider?.name ?? null });
    return c.json({ success: true });
  });
}
