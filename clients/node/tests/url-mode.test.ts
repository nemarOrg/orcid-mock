// `ORCID_MOCK_URL` mode: the helpers use a running instance instead of starting a container.
// The instance is this repository's server, started as a child process on a free port.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import pkg from "../package.json";
import { OrcidMockClient } from "../src/client";
import { defaultImage, IMAGE_REPOSITORY, resolveImage } from "../src/shared";
import { startOrConnect } from "../src/start";
import { type RepoServer, startRepoServer, withEnv } from "./support";

setDefaultTimeout(60_000);

let server: RepoServer;

beforeAll(async () => {
  server = await startRepoServer();
}, 30_000);

afterAll(async () => {
  await server?.stop();
});

describe("startOrConnect with ORCID_MOCK_URL", () => {
  test("connects to the running instance and signs in through it", async () => {
    const mock = await withEnv("ORCID_MOCK_URL", server.url, () => startOrConnect());
    expect(mock.mode).toBe("url");
    expect(mock.baseUrl).toBe(server.url);

    await mock.client.reset();
    const [alder] = await mock.client.users();
    if (!alder) throw new Error("the starter has users");
    const token = await mock.client.signIn({ orcid: alder.orcid });
    expect(token.orcid).toBe(alder.orcid);

    // The instance was not started here, so stop() must leave it running.
    await mock.stop();
    expect((await new OrcidMockClient(server.url).health()).status).toBe("ok");
  });

  test("a trailing slash in the variable is harmless", async () => {
    const mock = await withEnv("ORCID_MOCK_URL", `${server.url}/`, () => startOrConnect());
    expect(mock.baseUrl).toBe(server.url);
    expect((await mock.client.health()).status).toBe("ok");
  });

  test("a users option cannot be applied to a running instance, so it is an error", async () => {
    const failure = await withEnv("ORCID_MOCK_URL", server.url, () =>
      startOrConnect({ users: { clients: [], users: [] } }),
    ).then(
      () => null,
      (error: Error) => error,
    );
    expect(failure?.message).toContain("ORCID_MOCK_URL");
    expect(failure?.message).toContain("users");
  });

  test("a URL where nothing answers is an error naming it", async () => {
    const failure = await withEnv("ORCID_MOCK_URL", "http://127.0.0.1:1", () =>
      startOrConnect(),
    ).then(
      () => null,
      (error: Error) => error,
    );
    expect(failure?.message).toContain("http://127.0.0.1:1");
  });
});

describe("which image a container runs", () => {
  test("the default is the helper's own version, since helpers release in lockstep", () => {
    expect(defaultImage()).toBe(`${IMAGE_REPOSITORY}:${pkg.version}`);
    expect(IMAGE_REPOSITORY).toBe("ghcr.io/nemarorg/orcid-mock");
  });

  test("an option wins over ORCID_MOCK_IMAGE, which wins over the default", async () => {
    await withEnv("ORCID_MOCK_IMAGE", undefined, async () => {
      expect(resolveImage()).toBe(defaultImage());
      expect(resolveImage("mine:1")).toBe("mine:1");
    });
    await withEnv("ORCID_MOCK_IMAGE", "from-env:2", async () => {
      expect(resolveImage()).toBe("from-env:2");
      expect(resolveImage("mine:1")).toBe("mine:1");
    });
    await withEnv("ORCID_MOCK_IMAGE", "", async () => {
      expect(resolveImage()).toBe(defaultImage());
    });
  });
});
