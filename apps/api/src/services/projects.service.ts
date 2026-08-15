import type { DbConnection, ProjectRow } from "@nexus/database";
import { newId } from "../lib/crypto";
import { errors } from "../lib/errors";
import type { CreateProjectInput, Project } from "@nexus/types";
import type { AppContext } from "../context";

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProjectsService {
  constructor(
    private readonly db: DbConnection,
    private readonly ctx: AppContext,
  ) {}

  async list(): Promise<Project[]> {
    const rows = await this.db.all<ProjectRow>(`SELECT * FROM projects ORDER BY created_at DESC`);
    return Promise.all(
      rows.map(async (r) => {
        const [apps, dbs, games] = await Promise.all([
          this.db.get<{ c: number }>(`SELECT COUNT(*) as c FROM applications WHERE project_id = ?`, [r.id]),
          this.db.get<{ c: number }>(`SELECT COUNT(*) as c FROM databases WHERE project_id = ?`, [r.id]),
          this.db.get<{ c: number }>(`SELECT COUNT(*) as c FROM game_servers WHERE project_id = ?`, [r.id]),
        ]);
        return {
          ...toProject(r),
          applicationCount: Number(apps?.c ?? 0),
          databaseCount: Number(dbs?.c ?? 0),
          gameServerCount: Number(games?.c ?? 0),
        };
      }),
    );
  }

  async get(id: string): Promise<ProjectRow> {
    const row = await this.db.get<ProjectRow>(`SELECT * FROM projects WHERE id = ?`, [id]);
    if (!row) throw errors.notFound("Project not found");
    return row;
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const name = input.name.trim();
    if (name.length < 2) throw errors.validation({ name: "Name must be at least 2 characters" });
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || name.toLowerCase();
    const existing = await this.db.get<ProjectRow>(`SELECT id FROM projects WHERE slug = ?`, [slug]);
    if (existing) throw errors.conflict("A project with this name already exists");
    const now = new Date().toISOString();
    const row: ProjectRow = { id: newId("prj"), name, slug, description: input.description ?? null, created_at: now, updated_at: now };
    await this.db.run(`INSERT INTO projects (id, name, slug, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, [row.id, row.name, row.slug, row.description, row.created_at, row.updated_at]);
    await this.ctx.audit({ action: "project.create", resourceType: "project", resourceId: row.id, resourceName: name });
    return toProject(row);
  }

  async remove(id: string): Promise<void> {
    const row = await this.get(id);
    await this.db.run(`DELETE FROM projects WHERE id = ?`, [id]);
    await this.ctx.audit({ action: "project.delete", resourceType: "project", resourceId: id, resourceName: row.name });
  }
}
