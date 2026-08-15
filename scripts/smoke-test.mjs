/**
 * NEXUS dashboard smoke test (Node).
 *
 * Launches a headless system Edge via playwright-core, creates a real session
 * cookie directly in the SQLite DB (no password needed), then navigates every
 * route in the app and FAILS if any page throws a console error or a page
 * error (uncaught exception / unhandled rejection).
 *
 * Usage:
 *   node scripts/smoke-test.mjs        # or: npm run smoke
 *
 * Requires the API (localhost:8080) and dashboard dev server (localhost:5173)
 * to be running, and the SQLite DB at apps/api/data/nexus.sqlite.
 */
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { chromium } from "playwright-core";

const API_URL = process.env.API_URL ?? "http://localhost:8080";
const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "http://localhost:5173";
const DB_PATH = process.env.SMOKE_DB ?? "apps/api/data/nexus.sqlite";
const SESSION_COOKIE = "nexus_session";

/** Newest EdgeCore msedge.exe on the system (fallback to any Edge/Chrome). */
function findBrowser() {
  const candidates = [];
  const roots = [
    "C:/Program Files (x86)/Microsoft/EdgeCore",
    "C:/Program Files/Microsoft/EdgeCore",
    "C:/Program Files (x86)/Microsoft/Edge/Application",
    "C:/Program Files/Microsoft/Edge/Application",
    "C:/Program Files/Google/Chrome/Application",
    "C:/Program Files (x86)/Google/Chrome/Application",
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    if (/EdgeCore/i.test(root)) {
      try {
        const subs = readdirSync(root).filter((d) => /^\d/.test(d)).sort().reverse();
        for (const sub of subs) {
          const exe = `${root}/${sub}/msedge.exe`;
          if (existsSync(exe)) candidates.push(exe);
        }
      } catch {
        /* ignore */
      }
    } else {
      for (const name of ["msedge.exe", "chrome.exe"]) {
        const exe = `${root}/${name}`;
        if (existsSync(exe)) candidates.push(exe);
      }
    }
  }
  if (candidates.length === 0) {
    throw new Error(
      "No Edge/Chrome executable found. Install Edge or set SMOKE_BROWSER=/path/to/msedge.exe",
    );
  }
  return candidates[0];
}

/** Creates (or reuses) a user and returns a fresh session token. */
function createSession(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000;");
  try {
    const row = db
      .prepare("SELECT id, email FROM users ORDER BY created_at ASC LIMIT 1")
      .get();
    let userId;
    let email;
    if (row) {
      userId = row.id;
      email = row.email;
    } else {
      userId = `usr_${randomBytes(12).toString("hex")}`;
      email = `smoke-${Date.now()}@nexus.local`;
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO users (id, name, email, password_hash, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(userId, "Smoke Test", email, "x", "owner", now, now);
    }

    const token = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    db.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, last_used_at, user_agent, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `ses_${randomBytes(12).toString("hex")}`,
      userId,
      tokenHash,
      expires,
      now,
      "smoke-test",
      "127.0.0.1",
      now,
    );
    return { token, email };
  } finally {
    db.close();
  }
}

/** Every static route in the app (from App.tsx). */
const STATIC_ROUTES = [
  "/overview",
  "/projects",
  "/servers",
  "/applications",
  "/applications/new",
  "/deployments",
  "/databases",
  "/databases/new",
  "/containers",
  "/images",
  "/volumes",
  "/networks",
  "/domains",
  "/monitoring",
  "/game-servers",
  "/game-servers/new",
  "/backups",
  "/jobs",
  "/audit",
  "/notifications",
  "/settings",
];

/** Benign console patterns that should not fail the run. */
const IGNORED_CONSOLE = [
  /favicon/i,
  /React Router Future Flag Warning/i,
  /Download the React DevTools/i,
  /\[vite\]/i,
];

async function main() {
  // 1. Servers must be up.
  for (const [name, url] of [
    ["API", API_URL],
    ["Dashboard", DASHBOARD_URL],
  ]) {
    try {
      const res = await fetch(`${url}/`, { signal: AbortSignal.timeout(3000) });
      if (res.status >= 500) {
        console.error(`✗ ${name} at ${url} returned HTTP ${res.status}`);
        process.exit(1);
      }
    } catch (err) {
      console.error(`✗ ${name} at ${url} is not reachable: ${String(err)}`);
      console.error("  Start it first: npm run dev");
      process.exit(1);
    }
  }

  // 2. Create a real session.
  const { token } = createSession(DB_PATH);
  console.log(`✓ Session created in ${DB_PATH}`);

  // 3. Resolve dynamic detail routes by fetching lists from the API.
  const cookie = `${SESSION_COOKIE}=${token}`;
  const routes = [...STATIC_ROUTES];
  const listEndpoints = [
    ["/api/v1/servers", (id) => `/servers/${id}`],
    ["/api/v1/applications", (id) => `/applications/${id}`],
    ["/api/v1/databases", (id) => `/databases/${id}`],
    ["/api/v1/game-servers", (id) => `/game-servers/${id}`],
  ];
  for (const [ep, toRoute] of listEndpoints) {
    try {
      const res = await fetch(`${API_URL}${ep}`, {
        headers: { cookie },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const body = await res.json();
      const items = Array.isArray(body) ? body : body.items ?? [];
      const first = items[0];
      if (first?.id) routes.push(toRoute(first.id));
    } catch {
      /* list endpoint unavailable — skip detail route */
    }
  }

  // 4. Launch browser and walk every route.
  const executablePath = process.env.SMOKE_BROWSER ?? findBrowser();
  console.log(`✓ Browser: ${executablePath}`);

  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext();
  await context.addCookies([
    { name: SESSION_COOKIE, value: token, domain: "localhost", path: "/" },
  ]);
  const page = await context.newPage();

  const failures = [];
  const warnings = [];

  page.on("pageerror", (err) => {
    failures.push({ route: page.url(), message: String(err), type: "pageerror" });
  });
  page.on("console", (msg) => {
    if (msg.type() === "warning") {
      warnings.push({ route: page.url(), text: msg.text() });
      return;
    }
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
    failures.push({ route: page.url(), message: text, type: "console" });
  });

  const results = [];
  for (const route of routes) {
    try {
      await page.goto(`${DASHBOARD_URL}${route}`, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      // Let queries resolve + charts render.
      await page.waitForTimeout(1200);
      const url = new URL(page.url());
      const redirectedToLogin = url.pathname === "/login";
      if (redirectedToLogin) {
        failures.push({
          route,
          message: "redirected to /login (session rejected)",
          type: "console",
        });
      }
      results.push({ route, ok: !redirectedToLogin });
    } catch (err) {
      failures.push({ route, message: String(err), type: "pageerror" });
      results.push({ route, ok: false });
    }
  }

  // 5. Report.
  const uniqueFailures = failures.filter(
    (f, i, arr) =>
      arr.findIndex((g) => g.route === f.route && g.message === f.message) === i,
  );

  console.log("\n── Routes ───────────────────────────────────────");
  for (const r of results) {
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.route}`);
  }

  if (warnings.length > 0) {
    console.log(`\n── Console warnings (${warnings.length}) ──────────────`);
    for (const w of warnings.slice(0, 15)) {
      console.log(`  ⚠ ${w.text.slice(0, 160)}`);
    }
  }

  await browser.close();

  if (uniqueFailures.length > 0) {
    console.log(`\n✗ SMOKE TEST FAILED — ${uniqueFailures.length} error(s)`);
    for (const f of uniqueFailures) {
      console.log(`  [${f.type}] ${f.route}`);
      console.log(`    ${f.message.slice(0, 300)}`);
    }
    process.exit(1);
  }

  console.log(`\n✓ SMOKE TEST PASSED — ${results.length} routes, no console errors`);
  process.exit(0);
}

main().catch((err) => {
  console.error("✗ smoke test crashed:", err);
  process.exit(1);
});
