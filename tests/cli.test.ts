import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";
import { parseUsersFile } from "../src/fixtures/load";
import { usersFileJsonSchemaText } from "../src/fixtures/schema";
import { starterFixtureJson } from "../src/fixtures/starter";
import { isValidOrcidId } from "../src/orcid-id";
import { type ServerProcess, spawnCli, spawnServerProcess, startTestServer } from "./harness";

setDefaultTimeout(30_000);

const running: ServerProcess[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const child of running.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orcid-mock-"));
  dirs.push(dir);
  return dir;
}

describe("id", () => {
  test("-n 3 prints three distinct valid iDs inside the mint block", async () => {
    const { exitCode, stdout, stderr } = await spawnCli(["id", "-n", "3"]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const ids = stdout.trimEnd().split("\n");
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      expect(isValidOrcidId(id)).toBe(true);
      expect(id.startsWith("0009-9")).toBe(true);
    }
  });

  test("the default is one iD, and two runs differ", async () => {
    const a = await spawnCli(["id"]);
    const b = await spawnCli(["id"]);
    expect(a.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(a.stdout).not.toBe(b.stdout);
  });

  test("a bad count exits 2", async () => {
    for (const n of ["0", "-1", "abc", "1.5"]) {
      expect((await spawnCli(["id", "-n", n])).exitCode).toBe(2);
    }
  });
});

describe("fixture and schema", () => {
  test("fixture prints a users file that parses and loads", async () => {
    const { exitCode, stdout } = await spawnCli(["fixture"]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe(starterFixtureJson());
    const loaded = parseUsersFile(JSON.parse(stdout), Date.now());
    expect(loaded.ok).toBe(true);
  });

  test("fixture --out writes the file and prints nothing", async () => {
    const out = join(await tempDir(), "users.json");
    const { exitCode, stdout } = await spawnCli(["fixture", "--out", out]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    expect(await readFile(out, "utf8")).toBe(starterFixtureJson());
  });

  test("a written fixture serves", async () => {
    const out = join(await tempDir(), "users.json");
    await spawnCli(["fixture", "--out", out]);
    const child = await spawnServerProcess(["serve", "--port", "0", "--users", out]);
    running.push(child);
    const response = await fetch(`${child.url}/__admin/health`);
    expect(await response.json()).toEqual({ status: "ok", users: 3, clients: 2 });
  });

  test("schema output equals the committed schema", async () => {
    const { exitCode, stdout } = await spawnCli(["schema"]);
    expect(exitCode).toBe(0);
    const committed = await readFile(`${import.meta.dir}/../fixtures/users.schema.json`, "utf8");
    expect(stdout).toBe(committed);
    expect(stdout).toBe(usersFileJsonSchemaText());
  });

  test("schema --out writes the same text", async () => {
    const out = join(await tempDir(), "users.schema.json");
    await spawnCli(["schema", "--out", out]);
    expect(await readFile(out, "utf8")).toBe(usersFileJsonSchemaText());
  });
});

describe("health", () => {
  test("is 0 and silent against a running server", async () => {
    const child = await spawnServerProcess(["serve", "--port", "0"]);
    running.push(child);
    const result = await spawnCli(["health", "--url", child.url]);
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("a trailing slash on the URL is fine", async () => {
    const child = await spawnServerProcess(["serve", "--port", "0"]);
    running.push(child);
    expect((await spawnCli(["health", "--url", `${child.url}/`])).exitCode).toBe(0);
  });

  test("is 1 against a closed port", async () => {
    const closed = await startTestServer();
    const url = closed.baseUrl;
    await closed.stop();
    const result = await spawnCli(["health", "--url", url]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
  });

  test("is 1 when the server answers something other than 200", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("no", { status: 503 }) });
    try {
      const result = await spawnCli(["health", "--url", `http://127.0.0.1:${server.port}`]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("503");
    } finally {
      await server.stop(true);
    }
  });
});

describe("serve", () => {
  test("is the default command", async () => {
    const child = await spawnServerProcess([], { PORT: "0" });
    running.push(child);
    expect(child.url).toBe(`http://127.0.0.1:${child.port}`);
  });

  test("SIGTERM stops the server and exits 0", async () => {
    const child = await spawnServerProcess(["serve", "--port", "0"]);
    running.push(child);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    await expect(fetch(`${child.url}/__admin/health`)).rejects.toThrow();
  });

  test("SIGINT stops the server and exits 0", async () => {
    const child = await spawnServerProcess(["serve", "--port", "0"]);
    running.push(child);
    child.kill("SIGINT");
    expect(await child.exited).toBe(0);
  });
});

describe("meta", () => {
  test("--version prints the package version", async () => {
    const { exitCode, stdout } = await spawnCli(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
  });

  test("--help prints usage and exits 0", async () => {
    const { exitCode, stdout } = await spawnCli(["--help"]);
    expect(exitCode).toBe(0);
    for (const word of ["Usage", "serve", "id", "fixture", "schema", "health", "PUBLIC_BASE_URL"]) {
      expect(stdout).toContain(word);
    }
  });
});
