// The real-runtime portability gate from ADR 0002: the Worker entry is bundled exactly as a
// deploy would bundle it (`wrangler deploy --dry-run`, no `nodejs_compat`) and then run inside
// workerd, the runtime Cloudflare Workers use, through Miniflare. Requests go over a real socket;
// nothing here imports a handler or stands in for the runtime.
//
// Miniflare's own `dispatchFetch` cannot be used under Bun: Miniflare routes it through undici's
// `fetch` with a custom dispatcher, and Bun replaces the `undici` module with its built-in
// `fetch`, which ignores the dispatcher and tries to resolve the request's host. The workerd
// socket Miniflare opens is an ordinary HTTP server, so these tests talk to it directly.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { STARTER_USERS_FILE } from "../src/fixtures/starter";

setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");
const PUBLIC_BASE_URL = "https://orcid-mock.example.test";
/** Must not be later than the date of the installed workerd; wrangler.toml uses the same one. */
const COMPATIBILITY_DATE = "2026-09-01";

let workDir: string;
let bundle: string;

/** Bundles src/worker.ts the way `wrangler deploy` does, without uploading anything. */
async function bundleWorker(outDir: string): Promise<string> {
  const child = Bun.spawn(
    [process.execPath, "--bun", "x", "wrangler", "deploy", "--dry-run", "--outdir", outDir],
    {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG_PATH: join(outDir, "logs"),
      },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(`wrangler deploy --dry-run exited ${exitCode}\n${stdout}${stderr}`);
  return readFile(join(outDir, "worker.js"), "utf8");
}

interface RunningWorker {
  /** workerd's own listening address; the request's host is irrelevant to the Worker. */
  url: string;
  stop(): Promise<void>;
}

async function startWorker(bindings: Record<string, string>): Promise<RunningWorker> {
  const env = Object.fromEntries(
    Object.entries(bindings).map(([name, value]) => [name, { type: "text" as const, value }]),
  );
  const mf = new Miniflare({
    logRequests: false,
    // orcid-mock logs one JSON line per request through console.error, which workerd reports at
    // its error level; show everything except those info lines, so a real problem stays visible.
    handleStructuredLogs: ({ message }) => {
      if (!message.includes('"level":"info"')) console.error(message);
    },
    workers: [
      {
        config: {
          name: "orcid-mock",
          compatibilityDate: COMPATIBILITY_DATE,
          manifest: {
            mainModule: "worker.js",
            modulesRoot: workDir,
            modules: { "worker.js": { type: "esm", contents: bundle } },
          },
          env,
        },
      },
    ],
  });
  const url = String(await mf.ready);
  return { url, stop: () => mf.dispose() };
}

let worker: RunningWorker;
const unconfigured: RunningWorker[] = [];

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "orcid-mock-worker-"));
  bundle = await bundleWorker(join(workDir, "out"));
  worker = await startWorker({ PUBLIC_BASE_URL });
});

afterAll(async () => {
  await worker?.stop();
  for (const other of unconfigured) await other.stop();
  await rm(workDir, { recursive: true, force: true });
});

const get = (path: string, init?: RequestInit) => fetch(new URL(path, worker.url), init);

describe("the bundled Worker in workerd", () => {
  test("the bundle has no Node or Bun imports, which nodejs_compat would be needed for", () => {
    expect(bundle).not.toMatch(/from\s*["'](?:node|bun):/);
    expect(bundle).not.toMatch(/require\(\s*["'](?:node|bun):/);
  });

  test("GET /__admin/health answers 200 with the starter's counts", async () => {
    const response = await get("/__admin/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      users: STARTER_USERS_FILE.users.length,
      clients: STARTER_USERS_FILE.clients.length,
    });
  });

  test("an unknown /v3.0 path answers 404 in ORCID's error shape", async () => {
    const response = await get("/v3.0/x");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      "response-code": 404,
      "error-code": 9001,
      "more-info": "https://members.orcid.org/api/resources/troubleshooting",
    });
  });

  test("state lives in the isolate's store across requests, and reset clears it", async () => {
    const created = await get("/__admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: { given_names: "Worker", visibility: "public" } }),
    });
    expect(created.status).toBe(201);
    const health = async () =>
      ((await (await get("/__admin/health")).json()) as { users: number }).users;
    expect(await health()).toBe(STARTER_USERS_FILE.users.length + 1);
    expect((await get("/__admin/reset", { method: "POST" })).status).toBe(200);
    expect(await health()).toBe(STARTER_USERS_FILE.users.length);
  });

  test("the base URL is the binding, never the request: Origin is checked against it", async () => {
    // The request reaches workerd at 127.0.0.1:<port>, so if the Worker derived its base URL from
    // the request, that origin would be accepted and the binding's would be refused.
    const own = await get("/__admin/health", { headers: { origin: PUBLIC_BASE_URL } });
    expect(own.status).toBe(200);
    const requestOrigin = await get("/__admin/health", {
      headers: { origin: new URL(worker.url).origin },
    });
    expect(requestOrigin.status).toBe(403);
    expect(await requestOrigin.json()).toEqual({ error: "forbidden_origin" });
  });
});

describe("a Worker without a usable PUBLIC_BASE_URL", () => {
  test.each([
    ["is missing", {}, /PUBLIC_BASE_URL binding is not set/],
    ["is empty", { PUBLIC_BASE_URL: "" }, /PUBLIC_BASE_URL binding is not set/],
    ["is not a URL", { PUBLIC_BASE_URL: "orcid-mock" }, /must be an absolute http or https URL/],
  ])("answers 500 with a clear message when it %s", async (_label, bindings, message) => {
    const other = await startWorker(bindings);
    unconfigured.push(other);
    for (const path of ["/__admin/health", "/v3.0/x"]) {
      const response = await fetch(new URL(path, other.url));
      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: string; message: string };
      expect(body.error).toBe("misconfigured");
      expect(body.message).toMatch(message);
    }
  });
});
