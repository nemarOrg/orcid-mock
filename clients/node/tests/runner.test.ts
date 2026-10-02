// The Playwright fixtures through Playwright's own runner (`@playwright/test`), under Bun's runtime
// and under Node's, and against both kinds of mock: containers (one per worker) and a running
// instance named by ORCID_MOCK_URL. The project is tests/runner/; each case spawns the runner as
// a child process and reads its JSON report.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RepoServer, startRepoServer } from "./support";

setDefaultTimeout(300_000);

const PROJECT = join(import.meta.dir, "runner");

interface Report {
  stats: { expected: number; unexpected: number; flaky: number; skipped: number };
  /** The `mock` annotation of every test: the base URL of the mock it used. */
  mocks: string[];
}

interface JsonSuite {
  suites?: JsonSuite[];
  specs?: Array<{ tests: Array<{ annotations: Array<{ type: string; description?: string }> }> }>;
}

function collectMocks(suite: JsonSuite): string[] {
  const found: string[] = [];
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests) {
      for (const annotation of t.annotations) {
        if (annotation.type === "mock" && annotation.description)
          found.push(annotation.description);
      }
    }
  }
  for (const child of suite.suites ?? []) found.push(...collectMocks(child));
  return found;
}

/** Runs `playwright test` in tests/runner; `bunFlags` choose the runtime (`--bun` for Bun's). */
async function runPlaywright(opts: {
  bunFlags: string[];
  env: Record<string, string>;
  args?: string[];
}): Promise<Report> {
  const dir = await mkdtemp(join(tmpdir(), "orcid-mock-runner-"));
  const jsonPath = join(dir, "report.json");
  try {
    const child = Bun.spawn(
      [process.execPath, ...opts.bunFlags, "x", "playwright", "test", ...(opts.args ?? [])],
      {
        cwd: PROJECT,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
          ...(process.env.ORCID_MOCK_IMAGE
            ? { ORCID_MOCK_IMAGE: process.env.ORCID_MOCK_IMAGE }
            : {}),
          RUNNER_JSON: jsonPath,
          RUNNER_OUTPUT_DIR: join(dir, "test-results"),
          ...opts.env,
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
    if (exitCode !== 0) {
      throw new Error(`playwright test exited ${exitCode}\n${stdout}\n${stderr}`);
    }
    const report = JSON.parse(await readFile(jsonPath, "utf8")) as Report & JsonSuite;
    return { stats: report.stats, mocks: collectMocks(report) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("through Playwright's runner, with containers", () => {
  // `ORCID_MOCK_URL` is cleared by the child's own environment (it is not passed on).
  for (const [runtime, bunFlags] of [
    ["Bun's runtime", ["--bun"]],
    ["Node's runtime", []],
  ] as const) {
    test(`every spec passes under ${runtime}, and each worker has its own mock`, async () => {
      const report = await runPlaywright({ bunFlags: [...bunFlags], env: {} });
      expect(report.stats.unexpected).toBe(0);
      expect(report.stats.flaky).toBe(0);
      expect(report.stats.expected).toBe(4);
      // isolation.pw.ts and isolation-other.pw.ts ran in parallel workers on different mocks.
      expect(report.mocks).toHaveLength(4);
      expect(new Set(report.mocks).size).toBeGreaterThanOrEqual(2);
      for (const mock of report.mocks) expect(mock).toMatch(/^http:\/\/localhost:\d+$/);
    });
  }
});

describe("through Playwright's runner, against a running instance", () => {
  let server: RepoServer;
  beforeAll(async () => {
    server = await startRepoServer();
  }, 30_000);
  afterAll(async () => {
    await server?.stop();
  });

  test("ORCID_MOCK_URL is used as it is, with no container", async () => {
    const report = await runPlaywright({
      bunFlags: ["--bun"],
      env: { ORCID_MOCK_URL: server.url },
      // The options and isolation specs need a container of their own.
      args: ["--workers=1", "signin.pw.ts"],
    });
    expect(report.stats.expected).toBe(1);
    expect(report.mocks).toEqual([server.url]);
  });
});
