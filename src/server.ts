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

/**
 * The largest request body the socket accepts: 8 MiB, which is far above any fixture or form this
 * server takes (a users file of thousands of users is well under 1 MiB). Bun's default is 128
 * MiB, which an unauthenticated client could make the process buffer, and parse as JSON, once per
 * request. Bun answers a larger body 413 and closes the connection.
 */
export const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

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
  let text: string;
  try {
    text = await Bun.file(opts.usersFile).text();
  } catch (error) {
    // A missing file or a permission problem is a configuration error, not a bad fixture.
    throw new ConfigError(
      `USERS_FILE: cannot read ${JSON.stringify(opts.usersFile)}: ${reason(error)}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new FixtureError(
      [{ path: "", message: `not valid JSON: ${reason(error)}` }],
      `users file ${opts.usersFile}`,
    );
  }
}

/** An error's message on one line. */
function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
}

/** http://{host}:{port}, mapping a wildcard host to loopback and bracketing an IPv6 literal. */
function boundUrl(host: string, port: number): string {
  const wildcard = host === "0.0.0.0" || host === "::";
  const name = wildcard ? "127.0.0.1" : host;
  return `http://${name.includes(":") && !name.startsWith("[") ? `[${name}]` : name}:${port}`;
}

/**
 * The request with an absolute URL, so that routing never depends on `Host`. Bun builds
 * `Request.url` from the `Host` header and, when that header cannot be made into a URL (empty,
 * or holding a space, `/`, `@`, `?`, or `#`, or absent in HTTP/1.0), leaves it as the bare
 * request target; Hono's router then misreads the path and answers 404 to every route. The copy
 * puts the raw target under the origin of `PUBLIC_BASE_URL` and keeps the method, the headers
 * (the original `Host` included, which the admin guard reads to refuse it), and the body.
 */
function withStableUrl(request: Request, publicBaseUrl: string): Request {
  if (!request.url.startsWith("/")) return request;
  return new Request(`${new URL(publicBaseUrl).origin}${request.url}`, request);
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

  const server = Bun.serve({
    port: opts.port ?? DEFAULT_PORT,
    hostname: host,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    fetch: (request, bunServer) =>
      app.fetch(withStableUrl(request, config.publicBaseUrl), bunServer),
  });
  const port = server.port ?? 0;
  config.publicBaseUrl = explicitUrl ?? boundUrl(host, port);

  log.info("server_started", { url: config.publicBaseUrl, port, host });
  return { url: config.publicBaseUrl, port, stop: () => server.stop(true) };
}
