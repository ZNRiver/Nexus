/**
 * NEXUS — structured JSON logger.
 *
 * Every line is a JSON object:
 *   { ts, level, service, requestId?, userId?, serverId?, applicationId?, message, ...fields }
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  requestId?: string;
  userId?: string;
  serverId?: string;
  applicationId?: string;
  deploymentId?: string;
  databaseId?: string;
  [key: string]: unknown;
}

interface LoggerOptions {
  service: string;
  level?: LogLevel;
  pretty?: boolean;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

class Logger {
  private service: string;
  private minLevel: number;
  private pretty: boolean;

  constructor(opts: LoggerOptions) {
    this.service = opts.service;
    this.minLevel = LEVEL_ORDER[opts.level ?? (process.env.LOG_LEVEL as LogLevel) ?? "info"];
    this.pretty = opts.pretty ?? process.env.LOG_PRETTY === "true";
  }

  child(service: string): Logger {
    return new Logger({ service, level: this.minLevel === 10 ? "debug" : this.minLevel === 20 ? "info" : this.minLevel === 30 ? "warn" : "error", pretty: this.pretty });
  }

  log(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      service: this.service,
      message,
      ...fields,
    };
    if (this.pretty) {
      const meta = Object.entries(fields)
        .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
        .join(" ");
      const out = `${new Date(line.ts as string).toISOString()} [${level.toUpperCase()}] [${this.service}] ${message}${meta ? ` ${meta}` : ""}`;
      if (level === "error") console.error(out);
      else if (level === "warn") console.warn(out);
      else console.log(out);
    } else {
      if (level === "error") console.error(JSON.stringify(line));
      else if (level === "warn") console.warn(JSON.stringify(line));
      else console.log(JSON.stringify(line));
    }
  }

  debug(message: string, fields?: LogFields): void {
    this.log("debug", message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.log("info", message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.log("warn", message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.log("error", message, fields);
  }
}

export function createLogger(service: string, opts?: Partial<LoggerOptions>): Logger {
  return new Logger({ service, ...opts });
}

export type { Logger };

export const rootLogger = createLogger("nexus");
