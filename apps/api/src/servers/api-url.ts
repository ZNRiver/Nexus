import os from "node:os";

/** True when the URL host is a loopback address (localhost / 127.x / ::1). */
export function isLoopbackUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.");
  } catch {
    return true;
  }
}

/** Best local IPv4 reachable by `remoteHost` — same /24 preferred, then closest within /16, else first non-loopback. */
export function pickLocalIp(remoteHost: string): string | null {
  const t = remoteHost.split(".").map(Number);
  const candidates: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) candidates.push(a.address);
    }
  }
  if (candidates.length === 0) return null;
  if (t.length !== 4) return candidates[0];

  const parsed = candidates.map((ip) => ({ ip, o: ip.split(".").map(Number) })).filter((c) => c.o.length === 4);
  if (parsed.length === 0) return candidates[0];

  // Same /24 (first three octets equal) wins immediately.
  const same24 = parsed.find((c) => c.o[0] === t[0] && c.o[1] === t[1] && c.o[2] === t[2]);
  if (same24) return same24.ip;

  // Same /16: pick the interface numerically closest to the remote host
  // (e.g. remote 192.168.209.82 prefers 192.168.208.1 over 192.168.1.3).
  const same16 = parsed.filter((c) => c.o[0] === t[0] && c.o[1] === t[1]);
  if (same16.length > 0) {
    const dist = (c: { o: number[] }) => Math.abs((c.o[2]! * 256 + c.o[3]!) - (t[2]! * 256 + t[3]!));
    return same16.sort((a, b) => dist(a) - dist(b))[0]!.ip;
  }
  return parsed[0]!.ip;
}

/**
 * Build the API URL the remote agent should connect back to. An explicitly
 * configured URL (e.g. a public domain or IP via API_URL) is kept as-is;
 * a loopback default (http://localhost:8080) is replaced with the local IP
 * that best matches the remote host's subnet.
 */
export function resolveAgentApiUrl(remoteHost: string, port: number, configured: string): string {
  if (!isLoopbackUrl(configured)) return configured;
  const ip = pickLocalIp(remoteHost);
  if (!ip) return configured;
  return `http://${ip}:${port}`;
}
