// A proxy named by the environment must not capture the traffic to a mock on this machine.
// Bun's `fetch` sends even a request to localhost through HTTP_PROXY, so the client does not use
// it. The "proxy" below is a real server that records what reaches it; the mock is this
// repository's server, as a child process. The client runs in a second child process whose
// environment names the proxy at start-up, so no proxy setting reaches the other tests (Bun reads
// the variables once, and a leaked setting would send their requests to a proxy that is gone).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { type RepoServer, startRepoServer } from "./support";

let server: RepoServer;
let proxy: ReturnType<typeof Bun.serve>;
const seen: string[] = [];

beforeAll(async () => {
  server = await startRepoServer();
  proxy = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      seen.push(new URL(request.url).pathname);
      return new Response("captured by the proxy", { status: 502 });
    },
  });
}, 30_000);

afterAll(async () => {
  await proxy?.stop(true);
  await server?.stop();
});

test("proxy variables do not capture the client's traffic", async () => {
  const proxyUrl = `http://127.0.0.1:${proxy.port}`;
  const child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "proxy-probe.ts")], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      HTTP_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      ALL_PROXY: proxyUrl,
      all_proxy: proxyUrl,
      PROBE_SERVER_URL: server.localUrl,
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode, stderr).toBe(0);

  const result = JSON.parse(stdout) as { control: number; health: string; tokenType: string };
  // The control: a plain `fetch` was sent to the proxy, so the proxy would have captured the
  // client's traffic if the client used it.
  expect(result.control).toBe(502);
  expect(seen).toEqual(["/control"]);
  // And the client reached the real mock.
  expect(result.health).toBe("ok");
  expect(result.tokenType).toBe("bearer");
});
