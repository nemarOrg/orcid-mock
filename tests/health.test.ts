// `orcid-mock health` without --url checks the PORT the server would bind, which is how the
// container's HEALTHCHECK follows a PORT override. Real server processes, real exit codes.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ServerProcess, spawnCli, spawnServerProcess, startTestServer } from "./harness";

setDefaultTimeout(30_000);

const running: ServerProcess[] = [];
afterEach(async () => {
  for (const child of running.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
});

describe("health without --url", () => {
  test("follows the PORT environment variable", async () => {
    const child = await spawnServerProcess(["serve", "--port", "0"]);
    running.push(child);
    const result = await spawnCli(["health"], { env: { PORT: String(child.port) } });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("is 1 when nothing listens on PORT, and names the address it tried", async () => {
    const closed = await startTestServer();
    const port = new URL(closed.baseUrl).port;
    await closed.stop();
    const result = await spawnCli(["health"], { env: { PORT: port } });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`http://127.0.0.1:${port}`);
  });

  test("--url wins over PORT", async () => {
    const child = await spawnServerProcess(["serve", "--port", "0"]);
    running.push(child);
    const result = await spawnCli(["health", "--url", child.url], { env: { PORT: "1" } });
    expect(result.exitCode).toBe(0);
  });

  test("an invalid PORT is a usage error", async () => {
    for (const port of ["abc", "70000", "-1"]) {
      const result = await spawnCli(["health"], { env: { PORT: port } });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("PORT");
    }
  });

  test("PORT=0 has no address to check, so it is a usage error asking for --url", async () => {
    const result = await spawnCli(["health"], { env: { PORT: "0" } });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--url");
  });
});
