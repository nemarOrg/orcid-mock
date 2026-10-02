// Leveled JSON-lines logging for the portable layer.
// Lines go through console.error so that stdout stays free for the readiness line.
import type { MiddlewareHandler } from "hono";

export type LogLevel = "debug" | "info" | "warn" | "error";
export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

/** Serializes an Error as its name, message, and stack, which JSON.stringify would drop. */
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

function write(level: LogLevel, event: string, fields: LogFields | undefined): void {
  const line: LogFields = { ts: new Date().toISOString(), level, event };
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (!(key in line)) line[key] = value;
    }
  }
  try {
    console.error(JSON.stringify(line, replacer));
  } catch {
    // A circular field must not take a request down with it.
    console.error(
      JSON.stringify({ ts: line.ts, level, event, log_error: "fields were not serializable" }),
    );
  }
}

export function createLogger(level: LogLevel): Logger {
  const threshold = LOG_LEVELS.indexOf(level);
  const logAt =
    (at: LogLevel) =>
    (event: string, fields?: LogFields): void => {
      if (LOG_LEVELS.indexOf(at) >= threshold) write(at, event, fields);
    };
  return {
    debug: logAt("debug"),
    info: logAt("info"),
    warn: logAt("warn"),
    error: logAt("error"),
  };
}

const noop = (): void => {};

/** A logger that writes nothing, for tests that start servers quietly. */
export const silentLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };

/**
 * One line per request: method, path without its query string, status, and milliseconds.
 * Never headers, bodies, or the query string, which can carry codes and tokens.
 */
export function requestLog(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    await next();
    logger.info("request", {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round((performance.now() - started) * 10) / 10,
    });
  };
}
