import { chromium } from "playwright-core";

const EXE = process.env.CHROME_PATH ?? "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";
const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const EMAIL = process.env.NEXUS_EMAIL;
const PASSWORD = process.env.NEXUS_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error("Set NEXUS_EMAIL and NEXUS_PASSWORD to run the offline-state test.");
  process.exit(1);
}
const SERVER_ID = "srv_3f5977096a6b44f2b1aa";

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ baseURL: BASE });
const page = await ctx.newPage();

await page.goto("/login", { waitUntil: "networkidle" });
await page.fill('input[type="email"]', EMAIL);
await page.fill('input[type="password"]', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL("**/overview", { timeout: 15000 });

// Intercept: report the "teste" server as OFFLINE with a stale heartbeat — the
// exact payload the real API produces when a VPS is powered off.
await page.route("**/api/v1/servers", async (route) => {
  const res = await route.fetch();
  const body = await res.json();
  for (const s of body.items ?? []) {
    if (s.id === SERVER_ID) {
      s.status = "OFFLINE";
      s.lastHeartbeatAt = new Date(Date.now() - 120_000).toISOString();
    }
  }
  await route.fulfill({ response: res, json: body });
});

// 1) Servers list card
await page.goto("/servers", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
const serversText = await page.evaluate(() => document.body.innerText);
console.log("SERVERS LIST shows OFFLINE badge:", serversText.includes("OFFLINE") ? "YES" : "NO");
console.log("SERVERS LIST shows heartbeat age:", /hb\s+2m ago/.test(serversText) ? "YES" : "NO");

// 2) Server detail page
await page.route("**/api/v1/servers/**", async (route) => {
  const res = await route.fetch();
  const body = await res.json();
  if (body?.server?.id === SERVER_ID) {
    body.server.status = "OFFLINE";
    body.server.lastHeartbeatAt = new Date(Date.now() - 120_000).toISOString();
    body.metrics = { cpuPercent: 24.5, memoryPercent: 45, diskPercent: 12, memoryUsedBytes: 0, memoryTotalBytes: 0, diskUsedBytes: 0, diskTotalBytes: 0, loadAvg1: 0, loadAvg5: 0, loadAvg15: 0, uptimeSeconds: 0, containersRunning: 0, containersTotal: 0, containerStats: [] };
  }
  await route.fulfill({ response: res, json: body });
});
await page.goto(`/servers/${SERVER_ID}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
const detail = await page.evaluate(() => document.body.innerText);
const checks = {
  "offline banner": detail.includes("Server is offline"),
  "reconnect action": detail.includes("Reconnect"),
  "no stale CPU (24.5%)": !detail.includes("24.5"),
  "CPU shows dash": detail.includes("UNAVAILABLE"),
  "containers unavailable": detail.includes("Containers are unavailable"),
  "uptime hidden": detail.includes("Uptime") && !detail.includes("0h"),
};
for (const [k, v] of Object.entries(checks)) console.log(`  ${k.padEnd(26)} ${v ? "OK" : "FAIL"}`);

// 3) Overview server health
await page.unroute("**/api/v1/servers/**");
await page.route("**/api/v1/servers*", async (route) => {
  const res = await route.fetch();
  const body = await res.json();
  for (const s of body.items ?? []) {
    if (s.id === SERVER_ID) {
      s.status = "OFFLINE";
      s.lastHeartbeatAt = new Date(Date.now() - 120_000).toISOString();
    }
  }
  await route.fulfill({ response: res, json: body });
});
await page.goto("/overview", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
const overview = await page.evaluate(() => document.body.innerText);
console.log("OVERVIEW: offline server shows 'not reporting':", overview.includes("not reporting") ? "YES" : "NO");
console.log("OVERVIEW: no stale CPU% next to teste row:", !/teste[^]*\d+\.\d%/.test(overview.split("Server Health")[1] ?? "") ? "YES (no % shown)" : "check");

await browser.close();
console.log("\nDone.");
