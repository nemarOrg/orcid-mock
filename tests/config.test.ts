import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, parsePublicBaseUrl, resolveConfig } from "../src/config";
import { type ServerProcess, spawnCli, spawnServerProcess } from "./harness";

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

async function serve(args: string[] = [], env: Record<string, string> = {}) {
  const child = await spawnServerProcess(["serve", "--port", "0", ...args], env);
  running.push(child);
  return child;
}

async function tempFile(name: string, contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orcid-mock-"));
  dirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, contents);
  return path;
}

async function health(child: ServerProcess) {
  const response = await fetch(`http://127.0.0.1:${child.port}/__admin/health`);
  return (await response.json()) as { status: string; users: number; clients: number };
}

describe("an invalid configuration exits 2 with one line naming the variable", () => {
  const cases: Array<[string, Record<string, string>, string]> = [
    ["a relative PUBLIC_BASE_URL", { PUBLIC_BASE_URL: "/mock" }, "PUBLIC_BASE_URL"],
    ["an ftp PUBLIC_BASE_URL", { PUBLIC_BASE_URL: "ftp://orcid.example.test" }, "PUBLIC_BASE_URL"],
    [
      "a PUBLIC_BASE_URL with a query",
      { PUBLIC_BASE_URL: "http://orcid.example.test/?a=1" },
      "PUBLIC_BASE_URL",
    ],
    [
      "a PUBLIC_BASE_URL with a fragment",
      { PUBLIC_BASE_URL: "http://orcid.example.test/#top" },
      "PUBLIC_BASE_URL",
    ],
    [
      "a PUBLIC_BASE_URL with credentials",
      { PUBLIC_BASE_URL: "http://user:pw@orcid.example.test" },
      "PUBLIC_BASE_URL",
    ],
    ["a non-numeric PORT", { PORT: "http" }, "PORT"],
    ["a PORT above 65535", { PORT: "70000" }, "PORT"],
    ["an unknown LOG_LEVEL", { LOG_LEVEL: "verbose" }, "LOG_LEVEL"],
  ];
  for (const [label, env, variable] of cases) {
    test(label, async () => {
      const result = await spawnCli(["serve"], { env });
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      const lines = result.stderr.trimEnd().split("\n");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(variable);
    });
  }

  test("credentials in the URL are not echoed", async () => {
    const result = await spawnCli(["serve"], {
      env: { PUBLIC_BASE_URL: "http://user:hunter2@orcid.example.test" },
    });
    expect(result.stderr).not.toContain("hunter2");
  });

  test("a bad value from a flag names its variable and its flag", async () => {
    const result = await spawnCli(["serve", "--base-url", "ftp://x.example.test"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("PUBLIC_BASE_URL (--base-url)");
  });

  test("an unknown option or command exits 2", async () => {
    expect((await spawnCli(["serve", "--bogus"])).exitCode).toBe(2);
    expect((await spawnCli(["frobnicate"])).exitCode).toBe(2);
  });
});

describe("serving", () => {
  test("--port 0 reports the bound port and a base URL built from it", async () => {
    const child = await serve();
    expect(child.port).toBeGreaterThan(0);
    expect(child.url).toBe(`http://127.0.0.1:${child.port}`);
  });

  test("the starter serves when USERS_FILE is unset", async () => {
    const child = await serve();
    expect(await health(child)).toEqual({ status: "ok", users: 3, clients: 2 });
  });

  test("PUBLIC_BASE_URL is reported as given, minus one trailing slash, path prefix kept", async () => {
    const child = await serve([], { PUBLIC_BASE_URL: "https://orcid.example.test/mock/" });
    expect(child.url).toBe("https://orcid.example.test/mock");
    expect(child.port).toBeGreaterThan(0);
  });

  test("flags override the environment", async () => {
    const child = await spawnServerProcess(
      ["serve", "--port", "0", "--base-url", "http://flag.example.test"],
      { PUBLIC_BASE_URL: "http://env.example.test", PORT: "not-a-port" },
    );
    running.push(child);
    expect(child.url).toBe("http://flag.example.test");
  });

  test("the environment is used when no flag is given", async () => {
    const child = await spawnServerProcess(["serve"], { PORT: "0", HOST: "127.0.0.1" });
    running.push(child);
    expect(child.url).toBe(`http://127.0.0.1:${child.port}`);
  });

  test("a wildcard HOST is reported as 127.0.0.1", async () => {
    const child = await serve(["--host", "0.0.0.0"]);
    expect(child.url).toBe(`http://127.0.0.1:${child.port}`);
  });

  test("a users file replaces the starter", async () => {
    const path = await tempFile(
      "users.json",
      JSON.stringify({
        clients: [],
        users: [{ name: { given_names: "Solo", visibility: "public" } }],
      }),
    );
    const child = await serve(["--users", path]);
    expect(await health(child)).toEqual({ status: "ok", users: 1, clients: 0 });
  });

  test("USERS_FILE from the environment works the same", async () => {
    const path = await tempFile("users.json", JSON.stringify({ clients: [], users: [] }));
    const child = await serve([], { USERS_FILE: path });
    expect(await health(child)).toEqual({ status: "ok", users: 0, clients: 0 });
  });

  test("logs go to stderr and the readiness line is the only stdout line", async () => {
    const child = await serve(["--log-level", "debug"]);
    await fetch(`${child.url}/__admin/health`);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    const lines = child
      .stderr()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.map((line) => line.event)).toContain("server_started");
    const request = lines.find((line) => line.event === "request");
    expect(request).toMatchObject({ method: "GET", path: "/__admin/health", status: 200 });
    expect(typeof request.ms).toBe("number");
    expect(Object.keys(request)).not.toContain("query");
  });

  test("the request log never contains a query string", async () => {
    const child = await serve();
    await fetch(`${child.url}/__admin/health?code=secret-code&access_token=secret-token`);
    child.kill("SIGTERM");
    await child.exited;
    expect(child.stderr()).toContain("/__admin/health");
    expect(child.stderr()).not.toContain("secret");
  });
});

describe("an invalid users file exits 2 and lists every issue path", () => {
  test("a rule failure and a typo", async () => {
    const path = await tempFile(
      "users.json",
      JSON.stringify({
        clients: [],
        users: [
          { name: { given_names: "A", visibility: "public" } },
          {
            name: { given_names: "B", visibility: "public" },
            emails: [
              { email: "b@example.test", primary: true, verified: false, visibility: "public" },
            ],
          },
        ],
      }),
    );
    const result = await spawnCli(["serve", "--users", path]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("users[1].emails[0].visibility");

    const typo = await tempFile(
      "typo.json",
      JSON.stringify({
        clients: [],
        users: [{ name: { given_names: "A", familyname: "B", visibility: "public" } }],
      }),
    );
    const typoResult = await spawnCli(["serve", "--users", typo]);
    expect(typoResult.exitCode).toBe(2);
    expect(typoResult.stderr).toContain("users[0].name");
    expect(typoResult.stderr).toContain("familyname");
  });

  test("a file that is not JSON", async () => {
    const path = await tempFile("users.json", "{ not json");
    const result = await spawnCli(["serve", "--users", path]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("not valid JSON");
  });

  test("a file that does not exist names USERS_FILE", async () => {
    const result = await spawnCli(["serve", "--users", "/definitely/not/here.json"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("USERS_FILE");
  });
});

describe("resolveConfig on real values", () => {
  test("defaults", () => {
    expect(resolveConfig({}, {})).toEqual({
      core: { publicBaseUrl: null, logLevel: "info" },
      server: { port: 9700, host: "127.0.0.1", usersFile: null },
    });
  });

  test("the environment, then flags over it", () => {
    const env = {
      PUBLIC_BASE_URL: "http://env.example.test",
      PORT: "1234",
      HOST: "0.0.0.0",
      USERS_FILE: "/env/users.json",
      LOG_LEVEL: "warn",
    };
    expect(resolveConfig(env, {})).toEqual({
      core: { publicBaseUrl: "http://env.example.test", logLevel: "warn" },
      server: { port: 1234, host: "0.0.0.0", usersFile: "/env/users.json" },
    });
    expect(
      resolveConfig(env, {
        "base-url": "https://flag.example.test/prefix/",
        port: "0",
        host: "::1",
        users: "/flag/users.json",
        "log-level": "debug",
      }),
    ).toEqual({
      core: { publicBaseUrl: "https://flag.example.test/prefix", logLevel: "debug" },
      server: { port: 0, host: "::1", usersFile: "/flag/users.json" },
    });
  });

  test("an empty value counts as unset", () => {
    expect(resolveConfig({ PUBLIC_BASE_URL: "", PORT: "", USERS_FILE: "" }, { host: "" })).toEqual(
      resolveConfig({}, {}),
    );
  });

  test("PUBLIC_BASE_URL is normalized and validated", () => {
    expect(parsePublicBaseUrl("http://localhost:9700/")).toBe("http://localhost:9700");
    expect(parsePublicBaseUrl("HTTPS://Orcid.Example.test:443/a/b/")).toBe(
      "https://orcid.example.test/a/b",
    );
    expect(parsePublicBaseUrl("http://[::1]:9700")).toBe("http://[::1]:9700");
    for (const bad of [
      "",
      "localhost:9700",
      "/path",
      "ftp://x.test",
      "http://x.test?a=1",
      "http://x.test/#f",
      "http://u:p@x.test",
      "http://u@x.test",
    ]) {
      expect(() => parsePublicBaseUrl(bad)).toThrow(ConfigError);
    }
  });

  test("a bad value throws a ConfigError whose one-line message names the variable", () => {
    for (const [env, name] of [
      [{ PORT: "-1" }, "PORT"],
      [{ PORT: "1.5" }, "PORT"],
      [{ PORT: "65536" }, "PORT"],
      [{ LOG_LEVEL: "trace" }, "LOG_LEVEL"],
      [{ PUBLIC_BASE_URL: "nope" }, "PUBLIC_BASE_URL"],
    ] as const) {
      let message = "";
      try {
        resolveConfig(env, {});
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        message = (error as Error).message;
      }
      expect(message).toContain(name);
      expect(message).not.toContain("\n");
    }
  });
});
