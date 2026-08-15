import { Client, type SFTPWrapper } from "ssh2";
import { createLogger } from "@nexus/logger";
import { errors } from "../lib/errors";

const log = createLogger("api:ssh");

export interface SshOptions {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  timeoutMs?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class SSHService {
  async connect(opts: SshOptions): Promise<Client> {
    const client = new Client();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        client.end();
        reject(errors.serverError("SSH connection timed out"));
      }, opts.timeoutMs ?? 15000);
      client.on("ready", () => {
        clearTimeout(timer);
        resolve();
      });
      client.on("error", (err) => {
        clearTimeout(timer);
        reject(errors.badRequest(`SSH connection failed: ${err.message}`));
      });
      client.connect({
        host: opts.host,
        port: opts.port,
        username: opts.username,
        password: opts.password,
        privateKey: opts.privateKey,
        readyTimeout: opts.timeoutMs ?? 15000,
        keepaliveInterval: 10000,
      });
    });
    return client;
  }

  async execute(client: Client, command: string, timeoutMs = 60000): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) return reject(errors.serverError(`SSH exec failed: ${err.message}`));
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          stream.close();
          reject(errors.serverError(`SSH command timed out: ${command.slice(0, 80)}`));
        }, timeoutMs);
        stream.on("data", (d: Buffer) => (stdout += d.toString()));
        stream.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        stream.on("close", (code: number) => {
          clearTimeout(timer);
          resolve({ code: code ?? -1, stdout, stderr });
        });
      });
    });
  }

  async upload(client: Client, remotePath: string, data: Buffer, mode?: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err || !sftp) return reject(errors.serverError(`SFTP failed: ${err?.message ?? "unknown"}`));
        this.ensureRemoteDir(client, remotePath.slice(0, remotePath.lastIndexOf("/"))).then(() => {
          sftp.writeFile(remotePath, data, (writeErr) => {
            if (writeErr) return reject(errors.serverError(`Upload failed: ${writeErr.message}`));
            if (mode) sftp.chmod(remotePath, mode, () => resolve());
            else resolve();
          });
        }).catch(reject);
      });
    });
  }

  private async ensureRemoteDir(client: Client, dir: string): Promise<void> {
    const res = await this.execute(client, `mkdir -p ${quote(dir)}`);
    if (res.code !== 0) throw errors.serverError(`mkdir failed: ${res.stderr.trim()}`);
  }

  async close(client: Client): Promise<void> {
    client.end();
  }
}

/** Shell-quote a single argument safely. */
export function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Escape a value for systemd EnvironmentFile syntax. */
export function systemdEnvValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
