/**
 * Minimal SMTP client — no external dependencies.
 *
 * Supports implicit TLS (port 465), STARTTLS (587/25) and AUTH LOGIN.
 * Good enough for sending transactional emails (backup notifications).
 */
import net from "node:net";
import tls from "node:tls";

export interface SmtpSendOptions {
  host: string;
  port: number;
  /** Use TLS from the very first byte (SMTPS, typically port 465). */
  secure?: boolean;
  user?: string;
  pass?: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  /** Default 15s. */
  timeoutMs?: number;
}

class SmtpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmtpError";
  }
}

/**
 * Send an email over SMTP. Resolves on success, rejects on any failure.
 */
export async function sendEmail(opts: SmtpSendOptions): Promise<void> {
  const { host, port, secure = false, user, pass, from, to, subject, text, timeoutMs = 15_000 } = opts;

  // ---- raw socket (upgraded to TLS after STARTTLS when needed) ----
  let socket: net.Socket | tls.TLSSocket = secure
    ? tls.connect({ host, port, rejectUnauthorized: false })
    : net.connect({ host, port });
  socket.setTimeout(timeoutMs);

  let buffer = "";
  // Resolver for the next completed (multiline) reply, if awaiting one.
  let waiter: { resolve: (code: number, text: string[]) => void; reject: (err: Error) => void } | null = null;
  let errored = false;

  const fail = (err: Error) => {
    if (errored) return;
    errored = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.reject(err);
    }
  };

  const onData = (chunk: Buffer) => {
    if (errored) return;
    buffer += chunk.toString("utf8");
    // A reply is complete at the first line matching "<code> " — every line
    // before it is a continuation ("<code>-"). We only need the final line.
    const m = buffer.match(/\d{3} [^\r\n]*(?:\r?\n|$)/);
    if (!m) return;
    const full = buffer.slice(0, m.index! + m[0].length).trim();
    buffer = buffer.slice(m.index! + m[0].length);
    const code = parseInt(full.slice(0, 3), 10);
    const text = full.split(/\r?\n/).map((l) => l.slice(4));
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.resolve(code, text);
    }
  };

  socket.on("data", onData);
  socket.on("error", fail);
  socket.on("timeout", () => fail(new SmtpError("SMTP connection timed out")));

  const connectPromise = new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
    socket.once("timeout", () => reject(new SmtpError("SMTP connection timed out")));
  });

  const reply = (): Promise<{ code: number; text: string[] }> =>
    new Promise((resolve, reject) => {
      if (waiter) return reject(new SmtpError("SMTP protocol error: overlapping replies"));
      waiter = { resolve: (code, text) => resolve({ code, text }), reject };
      const t = setTimeout(() => {
        if (waiter) {
          const w = waiter;
          waiter = null;
          w.reject(new SmtpError("SMTP reply timed out"));
        }
      }, timeoutMs);
      // Clear the timeout when the waiter resolves.
      const orig = waiter.resolve;
      waiter.resolve = (code, text) => {
        clearTimeout(t);
        orig(code, text);
      };
    });

  const cmd = (line: string): Promise<{ code: number; text: string[] }> => {
    socket.write(line + "\r\n");
    return reply();
  };

  const ok = (r: { code: number; text: string[] }, expected = 250, what = "command"): void => {
    if (r.code !== expected) throw new SmtpError(`${what} failed: ${r.code} ${r.text.join(" ")}`);
  };

  try {
    await connectPromise;
    const greeting = await reply();
    ok(greeting, 220, "SMTP greeting");

    const ehlo = await cmd(`EHLO nexus.local`);
    ok(ehlo, 250, "EHLO");

    if (!secure && user) {
      const starttlsSupported = ehlo.text.some((l) => /STARTTLS/i.test(l));
      if (starttlsSupported) {
        const stls = await cmd("STARTTLS");
        ok(stls, 220, "STARTTLS");
        // Upgrade the socket to TLS and rewire the data handler.
        socket.removeAllListeners("data");
        const tlsSocket = tls.connect({ socket: socket as net.Socket, rejectUnauthorized: false });
        await new Promise<void>((resolve, reject) => {
          tlsSocket.once("secureConnect", resolve);
          tlsSocket.once("error", reject);
          tlsSocket.once("timeout", () => reject(new SmtpError("SMTP STARTTLS timed out")));
        });
        tlsSocket.on("data", onData);
        tlsSocket.on("error", fail);
        tlsSocket.on("timeout", () => fail(new SmtpError("SMTP connection timed out")));
        socket = tlsSocket;
        buffer = "";
        waiter = null;
        await cmd(`EHLO nexus.local`);
      }
    }

    if (user) {
      const auth = await cmd("AUTH LOGIN");
      if (auth.code === 334) {
        const u = await cmd(Buffer.from(user).toString("base64"));
        if (u.code !== 334) throw new SmtpError(`AUTH LOGIN username rejected: ${u.code} ${u.text.join(" ")}`);
        const p = await cmd(Buffer.from(pass ?? "").toString("base64"));
        ok(p, 235, "AUTH LOGIN password");
      } else if (auth.code !== 235) {
        throw new SmtpError(`AUTH LOGIN not supported: ${auth.code} ${auth.text.join(" ")}`);
      }
    }

    const mail = await cmd(`MAIL FROM:<${from}>`);
    ok(mail, 250, "MAIL FROM");

    for (const rcpt of to) {
      const r = await cmd(`RCPT TO:<${rcpt}>`);
      if (r.code !== 250 && r.code !== 251) throw new SmtpError(`RCPT TO ${rcpt} failed: ${r.code} ${r.text.join(" ")}`);
    }

    const data = await cmd("DATA");
    ok(data, 354, "DATA");

    const body = [
      `From: ${from}`,
      `To: ${to.join(", ")}`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      text,
      ".",
    ].join("\r\n");
    const dot = await cmd(body);
    ok(dot, 250, "message delivery");

    await cmd("QUIT").catch(() => {});
  } finally {
    socket.destroy();
  }
}
