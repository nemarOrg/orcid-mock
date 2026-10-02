// The conformance suite's own support code, which has no HTTP surface: the target loader and the
// structural checker. Both are tested directly, with real inputs, so a loader that quietly
// accepted a bad variable or a checker that passed a reordered body would fail here and not
// silently weaken the suite.
import { describe, expect, test } from "bun:test";
import { createClient, retryDelayMs } from "../conformance/client";
import { check, recordShapes } from "../conformance/shapes";
import { loadTarget } from "../conformance/target";
import { startTestServer } from "./harness";

const COMPLETE = {
  CONFORMANCE_TARGET: "sandbox",
  ORCID_API_BASE: "https://sandbox.orcid.org/",
  ORCID_PUB_API_BASE: "https://pub.sandbox.orcid.org",
  ORCID_CLIENT_ID: "APP-EXAMPLE0000000000",
  ORCID_CLIENT_SECRET: "a-secret-value-that-must-not-appear",
  ORCID_PUBLIC_ID: "0000-0002-1825-0097",
};

describe("loadTarget", () => {
  test("reads a complete environment", () => {
    const target = loadTarget(COMPLETE);
    expect(target.name).toBe("sandbox");
    expect(target.apiBase).toBe("https://sandbox.orcid.org");
    expect(target.pubApiBase).toBe("https://pub.sandbox.orcid.org");
    expect(target.clientId).toBe("APP-EXAMPLE0000000000");
    expect(target.publicId).toBe("0000-0002-1825-0097");
  });

  test("spaces the sandbox's requests and not the mock's", () => {
    expect(loadTarget(COMPLETE).requestDelayMs).toBeGreaterThan(0);
    expect(loadTarget({ ...COMPLETE, CONFORMANCE_TARGET: "mock" }).requestDelayMs).toBe(0);
  });

  test("names every missing variable in one message and prints no value", () => {
    const { ORCID_CLIENT_ID: _id, ORCID_CLIENT_SECRET: _secret, ...rest } = COMPLETE;
    const failure = (): Error => {
      try {
        loadTarget({ ...rest, ORCID_PUBLIC_ID: "   " });
      } catch (error) {
        return error as Error;
      }
      throw new Error("loadTarget accepted an incomplete environment");
    };
    const message = failure().message;
    for (const name of ["ORCID_CLIENT_ID", "ORCID_CLIENT_SECRET", "ORCID_PUBLIC_ID"]) {
      expect(message).toContain(name);
    }
    expect(message).not.toContain("sandbox.orcid.org");
  });

  test("never echoes a credential, whatever else is wrong", () => {
    for (const bad of [
      { ...COMPLETE, CONFORMANCE_TARGET: "prod" },
      { ...COMPLETE, ORCID_API_BASE: "not a url" },
      { ...COMPLETE, ORCID_PUB_API_BASE: "ftp://pub.example.test" },
      { ...COMPLETE, ORCID_PUBLIC_ID: "0000-0002-1825" },
    ]) {
      expect(() => loadTarget(bad)).toThrow();
      try {
        loadTarget(bad);
      } catch (error) {
        expect((error as Error).message).not.toContain(COMPLETE.ORCID_CLIENT_SECRET);
      }
    }
  });
});

describe("check", () => {
  const shape = {
    keys: {
      id: "number",
      name: { either: ["null", { keys: { value: "string" } }] },
      tags: { list: "string" },
      path: { is: "/x" },
      kind: { matches: /^work-\d+$/ },
      free: "any",
    },
  } as const;
  const good = { id: 1, name: { value: "a" }, tags: ["x"], path: "/x", kind: "work-7", free: {} };

  test("passes a body with the right keys in the right order and kinds", () => {
    expect(check(good, shape)).toEqual([]);
    expect(check({ ...good, name: null, tags: [] }, shape)).toEqual([]);
  });

  test("fails a reordered body and says where", () => {
    const { id, name, ...rest } = good;
    const reordered = { name, id, ...rest };
    expect(check(reordered, shape)).toEqual([
      "$: keys [name, id, tags, path, kind, free] but expected [id, name, tags, path, kind, free]",
    ]);
  });

  test("fails a missing key, an extra key, and a wrong kind", () => {
    const { tags: _tags, ...missing } = good;
    expect(check(missing, shape)[0]).toContain("keys [id, name, path, kind, free]");
    expect(check({ ...good, extra: 1 }, shape)[0]).toContain("extra");
    expect(check({ ...good, id: "1" }, shape)).toEqual(["$.id: expected number, got string"]);
    expect(check({ ...good, id: Number.NaN }, shape)).toEqual([
      "$.id: expected number, got number",
    ]);
    expect(check({ ...good, tags: ["x", 2] }, shape)).toEqual([
      "$.tags[1]: expected string, got number",
    ]);
    expect(check({ ...good, name: { value: 1 } }, shape)).toEqual([
      "$.name.value: expected string, got number",
    ]);
  });

  test("fails a path that is not the expected one and a kind that does not match", () => {
    expect(check({ ...good, path: "/y" }, shape)).toEqual(['$.path: expected "/x"']);
    expect(check({ ...good, kind: "work-x" }, shape)[0]).toContain("$.kind: expected a string");
  });

  test("tells an array and null from an object", () => {
    expect(check([], shape)).toEqual(["$: expected object, got array"]);
    expect(check(null, shape)).toEqual(["$: expected object, got null"]);
  });
});

describe("recordShapes", () => {
  test("hold a nearly empty record, the shape of a new account", () => {
    const iD = "0000-0001-6919-3953";
    const shapes = recordShapes(iD);
    const emptyContainer = (members: string, section: string) => ({
      "last-modified-date": null,
      [members]: [],
      path: `/${iD}/${section}`,
    });
    const works = emptyContainer("group", "works");
    expect(check(works, shapes.works)).toEqual([]);
    expect(check(emptyContainer("email", "email"), shapes.email)).toEqual([]);
    expect(check({ ...works, path: "/elsewhere/works" }, shapes.works)).toHaveLength(1);
  });
});

describe("retryDelayMs", () => {
  const NOW = Date.parse("2026-10-02T12:00:00Z");

  test("retries 429, 502, 503, and 504 and nothing else", () => {
    for (const status of [429, 502, 503, 504]) expect(retryDelayMs(status, null, NOW)).toBe(1000);
    for (const status of [200, 301, 400, 401, 404, 406, 415, 500, 501]) {
      expect(retryDelayMs(status, "1", NOW)).toBeNull();
    }
  });

  test("honors Retry-After in seconds and as an HTTP date", () => {
    expect(retryDelayMs(503, "0", NOW)).toBe(0);
    expect(retryDelayMs(503, "7", NOW)).toBe(7000);
    expect(retryDelayMs(429, " 3 ", NOW)).toBe(3000);
    expect(retryDelayMs(503, "Fri, 02 Oct 2026 12:00:05 GMT", NOW)).toBe(5000);
    expect(retryDelayMs(503, "Fri, 02 Oct 2026 11:00:00 GMT", NOW)).toBe(0);
  });

  test("caps the wait at 30 seconds and waits one second for a header it cannot read", () => {
    expect(retryDelayMs(503, "30", NOW)).toBe(30_000);
    expect(retryDelayMs(503, "3600", NOW)).toBe(30_000);
    expect(retryDelayMs(503, "Fri, 02 Oct 2026 18:00:00 GMT", NOW)).toBe(30_000);
    expect(retryDelayMs(503, "soon", NOW)).toBe(1000);
    expect(retryDelayMs(503, "-5", NOW)).toBe(1000);
  });
});

describe("the client", () => {
  /** A server that answers `statuses` in turn, then 200, and counts what it was asked. */
  function flakyServer(statuses: number[]) {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        const status = statuses[requests] ?? 200;
        requests += 1;
        return new Response("{}", { status, headers: { "retry-after": "0" } });
      },
    });
    return {
      url: `http://127.0.0.1:${server.port}`,
      count: () => requests,
      stop: () => server.stop(),
    };
  }

  const target = (base: string) =>
    loadTarget({
      CONFORMANCE_TARGET: "mock",
      ORCID_API_BASE: base,
      ORCID_PUB_API_BASE: base,
      ORCID_CLIENT_ID: "APP-EXAMPLE",
      ORCID_CLIENT_SECRET: "wrong-secret-that-must-not-appear",
      ORCID_PUBLIC_ID: "0000-0002-1825-0097",
    });

  test("retries a transient failure once and returns the second answer", async () => {
    const flaky = flakyServer([503]);
    try {
      const reply = await createClient(target(flaky.url)).request(`${flaky.url}/x`);
      expect(reply.status).toBe(200);
      expect(flaky.count()).toBe(2);
    } finally {
      flaky.stop();
    }
  });

  test("retries only once, so a persistent failure is reported and not hidden", async () => {
    const flaky = flakyServer([503, 503, 503]);
    try {
      const reply = await createClient(target(flaky.url)).request(`${flaky.url}/x`);
      expect(reply.status).toBe(503);
      expect(flaky.count()).toBe(2);
    } finally {
      flaky.stop();
    }
  });

  test("does not retry an answer that is not transient", async () => {
    const flaky = flakyServer([404]);
    try {
      const reply = await createClient(target(flaky.url)).request(`${flaky.url}/x`);
      expect(reply.status).toBe(404);
      expect(flaky.count()).toBe(1);
    } finally {
      flaky.stop();
    }
  });

  test("a refused token request says why in the server's words, without the secret", async () => {
    const server = await startTestServer();
    try {
      const client = createClient(target(server.baseUrl));
      const failure = await client.clientCredentialsToken().then(
        () => null,
        (error: Error) => error,
      );
      expect(failure).not.toBeNull();
      expect(failure?.message).toContain("401");
      expect(failure?.message).toContain("error: invalid_client");
      expect(failure?.message).toContain("error_description: Client authentication failed");
      expect(failure?.message).not.toContain("wrong-secret");
    } finally {
      await server.stop();
    }
  });
});
