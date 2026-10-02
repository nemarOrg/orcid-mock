// A proxy named by the environment must not capture the traffic to a mock on this machine.
// Bun's `fetch` sends even a request to localhost through HTTP_PROXY, so the client does not use
// it. The "proxy" below is a real server that records what reaches it; the mock is this
// repository's server, as a child process.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OrcidMockClient } from "../src/client";
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

describe("proxy variables", () => {
  test("do not capture the client's traffic", async () => {
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    const names = ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
    const clear = ["NO_PROXY", "no_proxy"];
    const before = Object.fromEntries([...names, ...clear].map((n) => [n, process.env[n]]));
    for (const name of names) process.env[name] = proxyUrl;
    for (const name of clear) delete process.env[name];
    try {
      // The control: a plain `fetch` is sent to the proxy, so the proxy would capture the
      // client's traffic if the client used it.
      const plain = await fetch(`${server.url}/__admin/health`);
      expect(plain.status).toBe(502);
      expect(seen).not.toEqual([]);
      seen.length = 0;

      const client = new OrcidMockClient(server.url);
      expect((await client.health()).status).toBe("ok");
      const [alder] = await client.users();
      if (!alder) throw new Error("the starter has users");
      expect((await client.signIn({ orcid: alder.orcid })).token_type).toBe("bearer");
      expect(seen).toEqual([]);
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
