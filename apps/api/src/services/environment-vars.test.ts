import { describe, expect, test } from "bun:test";
import { createDb, migrate, type DbConnection } from "@nexus/database";
import { getConfig } from "@nexus/config";
import { createLogger } from "@nexus/logger";
import { ApplicationsService } from "./applications.service";
import { DatabasesService } from "./databases.service";
import { GameServersService } from "./games.service";

const BULLET = String.fromCharCode(0x2022);
const MASKED = (n: number) => BULLET.repeat(n);

/** Fresh scratch SQLite database with a server row and a stubbed context. */
async function setup() {
  const db = createDb("sqlite::memory:");
  await migrate(db);
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO servers (id, name, type, host, port, username, auth_method, auth_data_encrypted, status, agent_id, agent_token_encrypted, agent_api_url, os, arch, hostname, cpu_model, cpu_cores, memory_total_bytes, disk_total_bytes, docker_version, docker_available, last_heartbeat_at, last_error, created_at, updated_at)
     VALUES (?, ?, 'local', 'localhost', 22, 'root', 'privateKey', NULL, 'ONLINE', NULL, NULL, NULL, 'linux', 'x64', 'test', NULL, 4, 1, 1, 'x', 1, NULL, NULL, ?, ?)`,
    ["srv_test", "Test Server", now, now],
  );
  const ctx = {
    config: getConfig({ DATABASE_URL: "sqlite::memory:" }),
    db,
    logger: createLogger("test"),
    hub: { isOnline: () => false },
    settings: async () => ({}),
    audit: async () => {},
    notify: async () => {},
  } as never;
  return { db, ctx };
}

describe("applications — raw .env round-trip", () => {
  test("comments and order survive a save and reload; secrets stay masked", async () => {
    const { db, ctx } = await setup();
    const apps = new ApplicationsService(db, ctx);
    const app = await apps.create({
      name: "roundtrip",
      serverId: "srv_test",
      repository: "https://github.com/org/repo.git",
      branch: "main",
      deploymentMethod: "DOCKERFILE",
    });

    const raw = [
      "# PostgreSQL — credenciais",
      "DATABASE_URL=postgres://erp:erp123@localhost:5433/erp",
      "",
      "# Admin inicial",
      "ADMIN_EMAIL=admin@erp.com",
      "ADMIN_PASSWORD=Admin@123",
      "ADMIN_NAME=Administrador",
    ].join("\n");
    const variables = [
      { key: "DATABASE_URL", value: "postgres://erp:erp123@localhost:5433/erp", isSecret: false },
      { key: "ADMIN_EMAIL", value: "admin@erp.com", isSecret: false },
      { key: "ADMIN_PASSWORD", value: "Admin@123", isSecret: true },
      { key: "ADMIN_NAME", value: "Administrador", isSecret: false },
    ];
    await apps.syncEnvVars(app.id, variables, raw);

    const text = (await apps.getPublic(app.id)).environmentText ?? "";
    expect(text).toContain("# PostgreSQL — credenciais");
    expect(text).toContain("# Admin inicial");
    expect(text.indexOf("DATABASE_URL")).toBeLessThan(text.indexOf("ADMIN_EMAIL"));
    expect(text).toContain("ADMIN_EMAIL=admin@erp.com");
    expect(text).not.toContain("ADMIN_PASSWORD=Admin@123");
    expect(text).toMatch(new RegExp(`ADMIN_PASSWORD=${BULLET}+`));

    // Rows exist with encrypted (masked) values.
    const rows = await apps.listEnvVars(app.id);
    const pass = rows.find((r) => r.key === "ADMIN_PASSWORD");
    expect(rows.map((r) => r.key).sort()).toEqual(["ADMIN_EMAIL", "ADMIN_NAME", "ADMIN_PASSWORD", "DATABASE_URL"]);
    expect(pass?.valueMasked).not.toContain("Admin@123");

    // Re-saving the stored text (dots) keeps the secret.
    await apps.syncEnvVars(app.id, variables, text);
    const revealed = await apps.revealEnvValue(app.id, pass!.id);
    expect(revealed.value).toBe("Admin@123");
  });

  test("empty value lines and blank lines are preserved", async () => {
    const { db, ctx } = await setup();
    const apps = new ApplicationsService(db, ctx);
    const app = await apps.create({
      name: "roundtrip2",
      serverId: "srv_test",
      repository: "https://github.com/org/repo.git",
      branch: "main",
      deploymentMethod: "DOCKERFILE",
    });
    const raw = "NVIDIA_API_KEY=\n\nFOO=bar";
    await apps.syncEnvVars(app.id, [{ key: "NVIDIA_API_KEY", value: "", isSecret: false }, { key: "FOO", value: "bar", isSecret: false }], raw);
    const text = (await apps.getPublic(app.id)).environmentText ?? "";
    expect(text).toBe("NVIDIA_API_KEY=\n\nFOO=bar");
  });
});

describe("databases — raw .env round-trip", () => {
  test("custom vars keep comments/order and merge over computed defaults", async () => {
    const { db, ctx } = await setup();
    const dbs = new DatabasesService(db, ctx);
    const created = await dbs.create({ name: "meudb", serverId: "srv_test", type: "POSTGRESQL" });

    const raw = ["# Custom extras", "TZ=America/Sao_Paulo", "", "# Limite de conexões", "MAX_CONNECTIONS=200"].join("\n");
    const variables = [
      { key: "TZ", value: "America/Sao_Paulo", isSecret: false },
      { key: "MAX_CONNECTIONS", value: "200", isSecret: false },
    ];
    await dbs.syncEnvVars(created.id, variables, raw);

    const text = (await dbs.getPublic(created.id)).environmentText ?? "";
    expect(text).toContain("# Custom extras");
    expect(text).toContain("# Limite de conexões");
    expect(text.indexOf("TZ=")).toBeLessThan(text.indexOf("MAX_CONNECTIONS="));

    // Effective env = computed defaults + custom (custom wins).
    const eff = Object.fromEntries((await dbs.env(created.id)).map((e) => [e.key, e.value]));
    expect(eff.TZ).toBe("America/Sao_Paulo");
    expect(eff.MAX_CONNECTIONS).toBe("200");
    expect(eff.POSTGRES_DB).toBe(created.name);
    expect(eff.POSTGRES_PASSWORD).toBe(MASKED(8));

    // Masked re-save keeps the stored value.
    const maskedText = text.replace("MAX_CONNECTIONS=200", "MAX_CONNECTIONS=" + MASKED(6));
    await dbs.syncEnvVars(created.id, variables, maskedText);
    const eff2 = Object.fromEntries((await dbs.env(created.id)).map((e) => [e.key, e.value]));
    expect(eff2.MAX_CONNECTIONS).toBe("200");
  });

  test("deleting a variable from the editor removes it", async () => {
    const { db, ctx } = await setup();
    const dbs = new DatabasesService(db, ctx);
    const created = await dbs.create({ name: "meudb2", serverId: "srv_test", type: "MYSQL" });
    await dbs.syncEnvVars(created.id, [{ key: "A", value: "1", isSecret: false }, { key: "B", value: "2", isSecret: false }], "A=1\nB=2");
    await dbs.syncEnvVars(created.id, [{ key: "A", value: "1", isSecret: false }], "A=1");
    const rows = await dbs.listCustomEnvVars(created.id);
    expect(rows.map((r) => r.key)).toEqual(["A"]);
  });
});

describe("game servers — raw .env round-trip", () => {
  test("startup editor preserves comments/order and masks RCON_PASSWORD", async () => {
    const { db, ctx } = await setup();
    const games = new GameServersService(db, ctx);
    const gs = await games.create({ name: "meu-minecraft", serverId: "srv_test", memoryBytes: 2048 ** 2 * 2 });

    const initial = await games.getStartup(gs.id);
    expect(initial.environmentText).toMatch(new RegExp(`RCON_PASSWORD=${BULLET}+`));
    expect(initial.environmentText).toContain("EULA=TRUE");

    const raw = ["# Servidor de testes", "MOTD=Server Legal", "", "# Memória do servidor", "MEMORY=2048M", "EULA=TRUE", `RCON_PASSWORD=${MASKED(8)}`].join("\n");
    await games.updateStartup(gs.id, { image: "itzg/minecraft-server:latest", rawText: raw });

    const after = await games.getStartup(gs.id);
    const text = after.environmentText ?? "";
    expect(text).toContain("# Servidor de testes");
    expect(text).toContain("# Memória do servidor");
    expect(text.indexOf("MOTD=")).toBeLessThan(text.indexOf("MEMORY="));
    expect(text).toContain("MOTD=Server Legal");
    expect(text).toMatch(new RegExp(`RCON_PASSWORD=${BULLET}+`));

    // Runtime env has real values; masked dots did not overwrite RCON_PASSWORD.
    expect(after.environment.MOTD).toBe("Server Legal");
    expect(after.environment.MEMORY).toBe("2048M");
    expect(after.environment.RCON_PASSWORD).not.toContain(BULLET);
    expect(after.environment.RCON_PASSWORD.length).toBeGreaterThan(0);

    const revealed = await games.revealEnvValue(gs.id, "RCON_PASSWORD");
    expect(revealed.value).toBe(after.environment.RCON_PASSWORD);
  });

  test("image-only save keeps the stored environment text", async () => {
    const { db, ctx } = await setup();
    const games = new GameServersService(db, ctx);
    const gs = await games.create({ name: "meu-minecraft2", serverId: "srv_test", memoryBytes: 2048 ** 2 * 2 });
    await games.updateStartup(gs.id, { rawText: "# comentário\nMEMORY=2048M" });
    await games.updateStartup(gs.id, { image: "itzg/minecraft-server:1.21" });
    const after = await games.getStartup(gs.id);
    expect(after.environmentText).toContain("# comentário");
    expect(after.image).toContain("1.21");
  });
});
