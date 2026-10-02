// The real-runtime portability gate from ADR 0002: the Worker entry is bundled exactly as a
// deploy would bundle it (`wrangler deploy --dry-run`, no `nodejs_compat`) and then run inside
// workerd, the runtime Cloudflare Workers use, through Miniflare. Requests go to the real workerd
// process; nothing here imports a handler or stands in for the runtime.
//
// Miniflare 4 is used on purpose: wrangler 4.117 and later pin Miniflare 5, an alpha with a new
// options shape whose `dispatchFetch` does not work under Bun. wrangler 4.116.0 pins the stable
// Miniflare 4 line, and the version of each is exact in package.json.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { STARTER_USERS_FILE } from "../src/fixtures/starter";

setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");
const PUBLIC_BASE_URL = "https://orcid-mock.example.test";

let workDir: string;
let bundle: string;
/** Read from wrangler.toml, so the test runs the Worker under the date a deploy would use. */
let compatibilityDate: string;

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

// Only what these tests use of a request and a response: Miniflare's own types differ from the
// global ones in details that do not matter here.
interface WorkerRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}
interface WorkerResponse {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

interface RunningWorker {
  /** Sends a request to the Worker; the host in the URL is irrelevant to it. */
  fetch(path: string, init?: WorkerRequestInit): Promise<WorkerResponse>;
  stop(): Promise<void>;
}

const REQUEST_HOST = "http://worker.test";

async function startWorker(bindings: Record<string, string>): Promise<RunningWorker> {
  const mf = new Miniflare({
    modules: true,
    script: bundle,
    compatibilityDate,
    bindings,
    logRequests: false,
    // orcid-mock logs one JSON line per request through console.error, which workerd reports at
    // its error level; show everything except those info lines, so a real problem stays visible.
    handleStructuredLogs: ({ message }: { message: string }) => {
      if (!message.includes('"level":"info"')) console.error(message);
    },
  });
  await mf.ready;
  return {
    fetch: (path, init) => mf.dispatchFetch(new URL(path, REQUEST_HOST).href, init),
    stop: () => mf.dispose(),
  };
}

let worker: RunningWorker;
const unconfigured: RunningWorker[] = [];

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "orcid-mock-worker-"));
  const wrangler = Bun.TOML.parse(await Bun.file(join(ROOT, "wrangler.toml")).text()) as {
    compatibility_date?: string;
    compatibility_flags?: string[];
  };
  expect(wrangler.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  // The flag that would let Node's built-ins in; ADR 0002 keeps it off.
  expect(wrangler.compatibility_flags ?? []).not.toContain("nodejs_compat");
  compatibilityDate = wrangler.compatibility_date as string;
  bundle = await bundleWorker(join(workDir, "out"));
  worker = await startWorker({ PUBLIC_BASE_URL });
});

afterAll(async () => {
  await worker?.stop();
  for (const other of unconfigured) await other.stop();
  await rm(workDir, { recursive: true, force: true });
});

const get = (path: string, init?: WorkerRequestInit) => worker.fetch(path, init);

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

  test("an unrouted /v3.0 path answers 404 in ORCID's error shape", async () => {
    // `/v3.0/x` is a read path since the record API: an unknown iD, and 406 for this request's
    // default `Accept`. A path no read route matches is the 9001.
    const response = await get("/v3.0/x/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      "response-code": 404,
      "error-code": 9001,
      "more-info": "https://members.orcid.org/api/resources/troubleshooting",
    });
  });

  test("a record read runs in workerd: personal-details, with URIs from the binding", async () => {
    const users = (await (await get("/__admin/users")).json()) as Array<{
      orcid: string;
      name: { given_names: string };
    }>;
    const alder = users.find((user) => user.name.given_names === "Alder");
    expect(alder).toBeDefined();
    const response = await get(`/v3.0/${alder?.orcid}/personal-details`, {
      headers: { accept: "application/json" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json;charset=UTF-8");
    expect(response.headers.get("cache-control")).toBe(
      "no-cache, no-store, max-age=0, must-revalidate",
    );
    const body = (await response.json()) as {
      name: { "given-names": { value: string }; "family-name": { value: string } };
      "other-names": { "other-name": Array<{ source: { "source-orcid": { uri: string } } }> };
    };
    expect(body.name["given-names"].value).toBe("Alder");
    expect(body.name["family-name"].value).toBe("Fennimore");
    expect(body["other-names"]["other-name"][0]?.source["source-orcid"].uri).toBe(
      `${PUBLIC_BASE_URL}/${alder?.orcid}`,
    );
    // No Accept header means XML at ORCID, which orcid-mock answers with its documented 406.
    expect((await get(`/v3.0/${alder?.orcid}/personal-details`)).status).toBe(406);
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
    // The request is addressed to ${REQUEST_HOST}, so if the Worker derived its base URL from the
    // request, that origin would be accepted and the binding's would be refused.
    const own = await get("/__admin/health", { headers: { origin: PUBLIC_BASE_URL } });
    expect(own.status).toBe(200);
    const requestOrigin = await get("/__admin/health", {
      headers: { origin: REQUEST_HOST },
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
      const response = await other.fetch(path);
      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: string; message: string };
      expect(body.error).toBe("misconfigured");
      expect(body.message).toMatch(message);
    }
  });
});
