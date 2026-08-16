import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";

const EXE = process.env.CHROME_PATH ?? "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";
const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const EMAIL = process.env.NEXUS_EMAIL;
const PASSWORD = process.env.NEXUS_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error("Set NEXUS_EMAIL and NEXUS_PASSWORD to run the audit.");
  process.exit(1);
}
const OUT = ".freebuff/shots";
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1366x768", width: 1366, height: 768 },
  { name: "1280x720", width: 1280, height: 720 },
  { name: "1024x768", width: 1024, height: 768 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "480x800", width: 480, height: 800 },
  { name: "390x844", width: 390, height: 844 },
  { name: "375x667", width: 375, height: 667 },
];

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ baseURL: BASE });
const page = await ctx.newPage();

// Login
await page.goto("/login", { waitUntil: "networkidle" });
if (!EMAIL || !PASSWORD) throw new Error("Set NEXUS_EMAIL/NEXUS_PASSWORD env vars (or edit this script) to log in.");
await page.fill('input[type="email"]', EMAIL);
await page.fill('input[type="password"]', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL("**/overview", { timeout: 15000 });

// Discover dynamic routes
const servers = await page.evaluate(async () => {
  const r = await fetch("/api/v1/servers");
  return (await r.json()).items;
});
const dbs = await page.evaluate(async () => {
  const r = await fetch("/api/v1/databases");
  return (await r.json()).items;
});
const apps = await page.evaluate(async () => {
  const r = await fetch("/api/v1/applications");
  return (await r.json()).items;
});
const games = await page.evaluate(async () => {
  const r = await fetch("/api/v1/game-servers");
  return (await r.json()).items;
});

const routes = [
  "/overview",
  "/projects",
  "/applications",
  "/deployments",
  "/databases",
  "/containers",
  "/images",
  "/volumes",
  "/networks",
  "/monitoring",
  "/domains",
  "/backups",
  "/jobs",
  "/audit",
  "/notifications",
  "/settings",
  "/git-providers",
  "/servers",
  ...servers.map((s) => `/servers/${s.id}`),
  ...dbs.map((d) => `/databases/${d.id}`),
  ...apps.map((a) => `/applications/${a.id}`),
  ...games.map((g) => `/game-servers/${g.id}`),
];

const report = [];
const failures = [];

for (const vp of VIEWPORTS) {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  for (const route of routes) {
    const file = `${OUT}/${vp.name}${route.replace(/\//g, "_")}.png`;
    try {
      await page.goto(route, { waitUntil: "networkidle", timeout: 20000 });
      await page.waitForTimeout(700);
      const probe = await page.evaluate(() => {
        const doc = document.documentElement;
        const over = doc.scrollWidth > window.innerWidth + 1;
        // elements sticking out of the right edge
        const offenders = [];
        if (over) {
          for (const el of Array.from(document.querySelectorAll("body *"))) {
            const r = el.getBoundingClientRect();
            if (r.right > window.innerWidth + 2 && r.width > 24 && !el.closest("pre, [data-overflow-ok]")) {
              offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 3).join(".")}:right=${Math.round(r.right)}`);
              if (offenders.length >= 6) break;
            }
          }
        }
        return { over, scrollW: doc.scrollWidth, innerW: window.innerWidth, offenders };
      });
      await page.screenshot({ path: file, fullPage: false });
      report.push({ vp: vp.name, route, ...probe });
      if (probe.over) failures.push({ vp: vp.name, route, ...probe });
      console.log(`${vp.name} ${route} ${probe.over ? "OVERFLOW" : "ok"}${probe.over ? " " + probe.offenders.join(" | ") : ""}`);
    } catch (e) {
      console.log(`${vp.name} ${route} ERROR ${e.message.split("\n")[0]}`);
      failures.push({ vp: vp.name, route, error: e.message.split("\n")[0] });
    }
  }
}

writeFileSync(".freebuff/responsive-report.json", JSON.stringify({ report, failures }, null, 2));
console.log(`\n=== FAILURES: ${failures.length} ===`);
await browser.close();
