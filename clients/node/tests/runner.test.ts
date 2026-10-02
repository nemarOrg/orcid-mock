// The Playwright fixtures through Playwright's own runner (`@playwright/test`), under Bun's runtime
// and under Node's, and against both kinds of mock: containers (one per worker) and a running
// instance named by ORCID_MOCK_URL. The project is tests/runner/; each case spawns the runner as
// a child process and reads its JSON report.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveImage } from "../src/shared";
import { type RepoServer, startRepoServer } from "./support";

setDefaultTimeout(300_000);

const PROJECT = join(import.meta.dir, "runner");

/** One test as the runner's JSON report records it. */
interface Ran {
  file: string;
  /** The `mock` annotation: the base URL of the mock the test used. */
  mock: string;
  workerIndex: number;
}

interface Report {
  exitCode: number;
  /** What the runner printed, for a failure's message and for a run that is expected to fail. */
  output: string;
  stats: { expected: number; unexpected: number; flaky: number; skipped: number };
  tests: Ran[];
}

interface JsonSuite {
  suites?: JsonSuite[];
  specs?: Array<{
    file: string;
    tests: Array<{
      annotations: Array<{ type: string; description?: string }>;
      results: Array<{ workerIndex: number }>;
    }>;
  }>;
}

function collectTests(suite: JsonSuite): Ran[] {
  const found: Ran[] = [];
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests) {
      const mock = t.annotations.find((annotation) => annotation.type === "mock")?.description;
      const workerIndex = t.results[0]?.workerIndex;
      if (mock !== undefined && workerIndex !== undefined) {
        found.push({ file: spec.file, mock, workerIndex });
      }
    }
  }
  for (const child of suite.suites ?? []) found.push(...collectTests(child));
  return found;
}

/**
 * What the runner needs from the environment to reach the Docker daemon and to start the image,
 * and nothing else: no inherited ORCID-mock settings.
 */
function passedThrough(): Record<string, string> {
  const names = [
    "PATH",
    "HOME",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
    "DOCKER_CONFIG",
    "ORCID_MOCK_IMAGE",
  ];
  const passed: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && (names.includes(name) || name.startsWith("TESTCONTAINERS_"))) {
      passed[name] = value;
    }
  }
  return passed;
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
          ...passedThrough(),
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
    const output = `${stdout}\n${stderr}`;
    const written = await Bun.file(jsonPath).exists();
    const report = written
      ? (JSON.parse(await readFile(jsonPath, "utf8")) as Pick<Report, "stats"> & JsonSuite)
      : { stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 } };
    return { exitCode, output, stats: report.stats, tests: collectTests(report as JsonSuite) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A run that must pass; the runner's output is the failure message. */
async function mustPass(opts: Parameters<typeof runPlaywright>[0]): Promise<Report> {
  const report = await runPlaywright(opts);
  if (report.exitCode !== 0) {
    throw new Error(`playwright test exited ${report.exitCode}\n${report.output}`);
  }
  return report;
}

describe("through Playwright's runner, with containers", () => {
  // `ORCID_MOCK_URL` is cleared by the child's own environment (it is not passed on).
  for (const [runtime, bunFlags] of [
    ["Bun's runtime", ["--bun"]],
    ["Node's runtime", []],
  ] as const) {
    test(`every spec passes under ${runtime}, and each worker has its own mock`, async () => {
      const report = await mustPass({ bunFlags: [...bunFlags], env: {} });
      expect(report.stats.unexpected).toBe(0);
      expect(report.stats.flaky).toBe(0);
      expect(report.stats.expected).toBe(4);
      expect(report.tests).toHaveLength(4);
      for (const { mock } of report.tests) expect(mock).toMatch(/^http:\/\/localhost:\d+$/);

      // A worker has one mock, and no mock has two workers: the mapping is one to one.
      const mockOfWorker = new Map<number, string>();
      const workerOfMock = new Map<string, number>();
      for (const { mock, workerIndex } of report.tests) {
        expect(mockOfWorker.get(workerIndex) ?? mock).toBe(mock);
        expect(workerOfMock.get(mock) ?? workerIndex).toBe(workerIndex);
        mockOfWorker.set(workerIndex, mock);
        workerOfMock.set(mock, workerIndex);
      }
      expect(mockOfWorker.size).toBeGreaterThanOrEqual(2);

      // The two isolation specs start together, on the two workers, each on its own mock.
      const first = report.tests.find((t) => t.file === "isolation.pw.ts");
      const second = report.tests.find((t) => t.file === "isolation-other.pw.ts");
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(first?.workerIndex).not.toBe(second?.workerIndex);
      expect(first?.mock).not.toBe(second?.mock);
    });
  }

  test("the image option wins over ORCID_MOCK_IMAGE", async () => {
    const bogus = "orcid-mock-does-not-exist:0";
    const base = { bunFlags: ["--bun"], args: ["--workers=1", "precedence.pw.ts"] };

    // The control: with only the environment to go by, the bogus image is what is started.
    const withoutOption = await runPlaywright({
      ...base,
      env: { RUNNER_PRECEDENCE: "1", ORCID_MOCK_IMAGE: bogus },
    });
    expect(withoutOption.exitCode).not.toBe(0);
    expect(withoutOption.output).toContain(bogus);

    const withOption = await mustPass({
      ...base,
      env: {
        RUNNER_PRECEDENCE: "1",
        ORCID_MOCK_IMAGE: bogus,
        RUNNER_IMAGE_OPTION: resolveImage(),
      },
    });
    expect(withOption.stats.expected).toBe(1);
  });
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
    const report = await mustPass({
      bunFlags: ["--bun"],
      env: { ORCID_MOCK_URL: server.localUrl },
      // The options and isolation specs need a container of their own, and workers share the one
      // instance, so it runs on one worker.
      args: ["--workers=1", "signin.pw.ts"],
    });
    expect(report.stats.expected).toBe(1);
    expect(report.tests.map((t) => t.mock)).toEqual([server.localUrl]);
  });
});
