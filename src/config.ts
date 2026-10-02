// Configuration shared by every way of running the mock.
// The portable parts (CoreConfig) are what the app needs; ServerConfig is what only the Bun
// entry points need. Nothing here reads argv, files, or the process environment: the caller
// passes the environment and the parsed flags in.
import type { LogLevel } from "./log";
import { LOG_LEVELS } from "./log";

export interface CoreConfig {
  /** Every absolute URL the mock emits derives from this, never from the `Host` header. */
  publicBaseUrl: string;
  logLevel: LogLevel;
}

export interface ServerConfig {
  port: number;
  host: string;
  /** Path to a users file, or null for the bundled starter. */
  usersFile: string | null;
}

export type ConfigFlags = Partial<
  Record<"base-url" | "port" | "host" | "users" | "log-level", string>
>;

export interface ResolvedConfig {
  /** `publicBaseUrl` stays null until the server knows the port it bound. */
  core: Omit<CoreConfig, "publicBaseUrl"> & { publicBaseUrl: string | null };
  server: ServerConfig;
}

/** An invalid setting; the message is one line and names the variable. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

export const DEFAULT_PORT = 9700;
export const DEFAULT_HOST = "127.0.0.1";

/** Flags win over the environment; an empty value counts as unset in both. */
function pick(
  env: Record<string, string | undefined>,
  flags: ConfigFlags,
  variable: string,
  flag: keyof ConfigFlags,
): { value: string | undefined; source: string } {
  const fromFlag = flags[flag];
  if (fromFlag !== undefined && fromFlag !== "") {
    return { value: fromFlag, source: `${variable} (--${flag})` };
  }
  const fromEnv = env[variable];
  return { value: fromEnv === "" ? undefined : fromEnv, source: variable };
}

/**
 * Validates a public base URL: absolute http or https, no query, no fragment, no credentials.
 * Strips trailing slashes; a path prefix is kept and used only when building URLs.
 */
export function parsePublicBaseUrl(raw: string, source = "PUBLIC_BASE_URL"): string {
  const shown = JSON.stringify(raw);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${source}: must be an absolute http or https URL, got ${shown}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${source}: scheme must be http or https, got ${shown}`);
  }
  if (url.username !== "" || url.password !== "" || /^[a-z]+:\/\/[^/?#]*@/i.test(raw)) {
    // The value is not echoed: it would put the credentials in the log.
    throw new ConfigError(`${source}: must not contain credentials`);
  }
  if (raw.includes("?") || raw.includes("#")) {
    throw new ConfigError(`${source}: must not contain a query or fragment, got ${shown}`);
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

export function parsePort(raw: string, source: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) > 65535) {
    throw new ConfigError(
      `${source}: must be an integer from 0 to 65535, got ${JSON.stringify(raw)}`,
    );
  }
  return Number(raw);
}

function parseLogLevel(raw: string, source: string): LogLevel {
  const level = LOG_LEVELS.find((candidate) => candidate === raw);
  if (level === undefined) {
    throw new ConfigError(
      `${source}: must be one of ${LOG_LEVELS.join(", ")}, got ${JSON.stringify(raw)}`,
    );
  }
  return level;
}

export function resolveConfig(
  env: Record<string, string | undefined>,
  flags: ConfigFlags = {},
): ResolvedConfig {
  const baseUrl = pick(env, flags, "PUBLIC_BASE_URL", "base-url");
  const port = pick(env, flags, "PORT", "port");
  const host = pick(env, flags, "HOST", "host");
  const users = pick(env, flags, "USERS_FILE", "users");
  const level = pick(env, flags, "LOG_LEVEL", "log-level");
  return {
    core: {
      publicBaseUrl:
        baseUrl.value === undefined ? null : parsePublicBaseUrl(baseUrl.value, baseUrl.source),
      logLevel: level.value === undefined ? "info" : parseLogLevel(level.value, level.source),
    },
    server: {
      port: port.value === undefined ? DEFAULT_PORT : parsePort(port.value, port.source),
      host: host.value ?? DEFAULT_HOST,
      usersFile: users.value ?? null,
    },
  };
}
