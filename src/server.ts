// The Bun entry: loads the users file, builds the store and the app, and binds a real socket.
// The readiness line and signal handling live in main.ts so tests can start servers quietly.

import { createMockApp } from "./bootstrap";
import {
  ConfigError,
  type CoreConfig,
  DEFAULT_HOST,
  DEFAULT_PORT,
  parsePublicBaseUrl,
} from "./config";
import { FixtureError } from "./fixtures/load";
import { STARTER_USERS_FILE } from "./fixtures/starter";
import type { LogLevel } from "./log";
import { createLogger, silentLogger } from "./log";

export interface StartOptions {
  /** 0 picks a free port. Default 9700. */
  port?: number;
  /** Default 127.0.0.1, since the admin API is unauthenticated. */
  host?: string;
  /** Path to a users file; null or absent serves the bundled starter. */
  usersFile?: string | null;
  /** A users file already parsed from JSON, which tests use; wins over `usersFile`. */
  users?: unknown;
  /** Default: http://{host}:{boundPort}, with a wildcard host reported as 127.0.0.1. */
  publicBaseUrl?: string | null;
  logLevel?: LogLevel;
  /** Writes no log lines. */
  quiet?: boolean;
}

export interface RunningServer {
  /** The public base URL the mock puts in every absolute URL it emits. */
  url: string;
  /** The port actually bound. */
  port: number;
  stop(): Promise<void>;
}

async function readUsers(opts: StartOptions): Promise<unknown> {
  if (opts.users !== undefined) return opts.users;
  if (opts.usersFile == null) return STARTER_USERS_FILE;
  const file = Bun.file(opts.usersFile);
  if (!(await file.exists())) {
    throw new ConfigError(`USERS_FILE: no such file ${JSON.stringify(opts.usersFile)}`);
  }
  try {
    return JSON.parse(await file.text());
  } catch {
    throw new FixtureError(
      [{ path: "", message: "not valid JSON" }],
      `users file ${opts.usersFile}`,
    );
  }
}

/** http://{host}:{port}, mapping a wildcard host to loopback and bracketing an IPv6 literal. */
function boundUrl(host: string, port: number): string {
  const wildcard = host === "0.0.0.0" || host === "::";
  const name = wildcard ? "127.0.0.1" : host;
  return `http://${name.includes(":") && !name.startsWith("[") ? `[${name}]` : name}:${port}`;
}

export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? DEFAULT_HOST;
  const logLevel = opts.logLevel ?? "info";
  const log = opts.quiet ? silentLogger : createLogger(logLevel);
  const explicitUrl = opts.publicBaseUrl ? parsePublicBaseUrl(opts.publicBaseUrl) : null;

  // The app keeps this object by reference; the real base URL is set once the port is bound,
  // and no request can arrive before then because nothing awaits in between.
  const config: CoreConfig = { publicBaseUrl: explicitUrl ?? "", logLevel };
  const { app } = await createMockApp({
    users: await readUsers(opts),
    config,
    nowMs: Date.now(),
    log,
    source: opts.usersFile ? `users file ${opts.usersFile}` : "users file",
  });

  const server = Bun.serve({ port: opts.port ?? DEFAULT_PORT, hostname: host, fetch: app.fetch });
  const port = server.port ?? 0;
  config.publicBaseUrl = explicitUrl ?? boundUrl(host, port);

  log.info("server_started", { url: config.publicBaseUrl, port, host });
  return { url: config.publicBaseUrl, port, stop: () => server.stop(true) };
}
