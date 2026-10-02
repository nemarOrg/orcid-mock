// The test harness, FROZEN after phase 1: later phases add helpers under tests/helpers/*.ts.
// Every route test file uses one server for the whole file:
//   beforeAll(async () => { server = await startTestServer(); }, 10_000);
//   beforeEach(() => server.reset());
//   afterAll(() => server.stop());
// and never test.concurrent, since the tests share that server's state.
import { startServer } from "../src/server";

const REPO_ROOT = `${import.meta.dir}/..`;

export interface AdminResponse<T> {
  status: number;
  /** The parsed JSON body, the raw text if it is not JSON, or undefined for an empty body. */
  body: T;
}

export interface TestServer {
  /** Where to send requests: the real socket the server bound on 127.0.0.1. */
  baseUrl: string;
  /** The public base URL the server puts in the URLs it emits (equal to `baseUrl` by default). */
  publicBaseUrl: string;
  stop(): Promise<void>;
  /** POST /__admin/reset: users, clients, counters, codes, tokens, and sessions back to baseline. */
  reset(): Promise<void>;
  /** `path` is relative to /__admin (`/users`) or already starts with it; `body` is JSON. */
  admin<T = unknown>(method: string, path: string, body?: unknown): Promise<AdminResponse<T>>;
}

/** Starts the real server on a free port, in this process, with logging off. */
export async function startTestServer(
  opts: { users?: unknown; publicBaseUrl?: string } = {},
): Promise<TestServer> {
  const server = await startServer({
    port: 0,
    quiet: true,
    ...(opts.users === undefined ? {} : { users: opts.users }),
    ...(opts.publicBaseUrl === undefined ? {} : { publicBaseUrl: opts.publicBaseUrl }),
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;

  const admin = async <T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<AdminResponse<T>> => {
    const url = `${baseUrl}${path.startsWith("/__admin") ? path : `/__admin${path}`}`;
    const response = await fetch(url, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown;
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: response.status, body: parsed as T };
  };

  return {
    baseUrl,
    publicBaseUrl: server.url,
    stop: () => server.stop(),
    reset: async () => {
      const response = await admin("POST", "/reset");
      if (response.status !== 200) throw new Error(`reset answered ${response.status}`);
    },
    admin,
  };
}

/** The environment a spawned CLI gets: no inherited ORCID-mock settings, so runs are repeatable. */
function childEnv(extra: Record<string, string> | undefined): Record<string, string> {
  const base: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR"]) {
    const value = process.env[key];
    if (value !== undefined) base[key] = value;
  }
  return { ...base, ...extra };
}

function spawnMain(args: string[], env: Record<string, string> | undefined) {
  return Bun.spawn([process.execPath, "src/main.ts", ...args], {
    cwd: REPO_ROOT,
    env: childEnv(env),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs `bun src/main.ts ...args` to completion, draining both pipes; kills it on timeout. */
export async function spawnCli(
  args: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<CliResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const child = spawnMain(args, opts.env);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (timedOut) {
      throw new Error(`orcid-mock ${args.join(" ")} timed out after ${timeoutMs} ms\n${stderr}`);
    }
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
  }
}

export interface ServerProcess {
  /** The `url` from the readiness line. */
  url: string;
  /** The `port` from the readiness line. */
  port: number;
  /** Everything the process has written to stderr so far. */
  stderr(): string;
  kill(signal?: NodeJS.Signals): void;
  /** Resolves with the exit code. */
  exited: Promise<number>;
}

const liveChildren = new Set<{ kill(signal?: NodeJS.Signals): void }>();
// A test that throws before its cleanup must still not leave a server running.
process.on("exit", () => {
  for (const child of liveChildren) child.kill("SIGKILL");
});

/**
 * Starts `bun src/main.ts ...args` and waits for the readiness line on stdout (not a health
 * poll); rejects, after killing the child, if it exits first or takes longer than `timeoutMs`.
 */
export async function spawnServerProcess(
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 15_000,
): Promise<ServerProcess> {
  const child = spawnMain(args, env);
  liveChildren.add(child);
  child.exited.then(() => liveChildren.delete(child));

  let stderr = "";
  const drainErr = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) stderr += decoder.decode(chunk);
  })();

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error(
          `orcid-mock exited before it was ready (code ${await child.exited})\n${stderr}`,
        );
      }
      buffer += decoder.decode(value, { stream: true });
      const newline = buffer.indexOf("\n");
      if (newline === -1) continue;
      const line = JSON.parse(buffer.slice(0, newline)) as {
        event: string;
        url: string;
        port: number;
      };
      if (line.event !== "listening") throw new Error(`unexpected first stdout line: ${buffer}`);
      reader.releaseLock();
      // Keep draining stdout so a full pipe never blocks the child.
      const drainOut = (async () => {
        for await (const _ of child.stdout) {
          // discarded
        }
      })();
      return {
        url: line.url,
        port: line.port,
        stderr: () => stderr,
        kill: (signal = "SIGTERM") => child.kill(signal),
        // Resolves once both pipes are drained, so stderr() is complete when it does.
        exited: Promise.all([child.exited, drainOut, drainErr]).then(([code]) => code),
      };
    }
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
