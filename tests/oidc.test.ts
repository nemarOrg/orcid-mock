import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { startTestServer, type TestServer } from "./harness";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
}, 10_000);
beforeEach(() => server.reset());
afterAll(() => server.stop());

interface PublishedKey {
  kty: string;
  e: string;
  use: string;
  kid: string;
  n: string;
}

async function fetchJwks(baseUrl: string = server.baseUrl) {
  const response = await fetch(`${baseUrl}/oauth/jwks`);
  const text = await response.text();
  return { response, text, keys: (JSON.parse(text) as { keys: PublishedKey[] }).keys };
}

describe("GET /oauth/jwks", () => {
  test("is ORCID's compact one-key document with no alg member", async () => {
    const { response, text, keys } = await fetchJwks();
    expect(response.status).toBe(200);
    expect(text).toMatch(
      /^\{"keys":\[\{"kty":"RSA","e":"AQAB","use":"sig","kid":"orcid-mock-[0-9a-z]{32}","n":"[\w-]+"\}\]\}$/,
    );
    expect(keys).toHaveLength(1);
    // The 2048-bit modulus is 256 bytes; base64url without padding.
    expect(Buffer.from(keys[0]?.n ?? "", "base64url")).toHaveLength(256);
  });

  test("carries ORCID's cache headers, a JSON content type, and CORS", async () => {
    const { response } = await fetchJwks();
    expect(response.headers.get("content-type")).toBe("application/json;charset=UTF-8");
    expect(response.headers.get("cache-control")).toBe(
      "no-cache, no-store, max-age=0, must-revalidate",
    );
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("the kid is stable across requests and across a reset", async () => {
    const first = await fetchJwks();
    expect((await fetchJwks()).keys[0]).toEqual(first.keys[0] as PublishedKey);
    await server.reset();
    expect((await fetchJwks()).keys[0]).toEqual(first.keys[0] as PublishedKey);
  });

  test("two servers publish two different keys", async () => {
    const other = await startTestServer();
    try {
      const mine = (await fetchJwks()).keys[0];
      const theirs = (await fetchJwks(other.baseUrl)).keys[0];
      expect(theirs?.kid).not.toBe(mine?.kid);
      expect(theirs?.n).not.toBe(mine?.n);
    } finally {
      await other.stop();
    }
  });

  test("a server's first requests, fired together, agree on one key", async () => {
    const fresh = await startTestServer();
    try {
      const results = await Promise.all(Array.from({ length: 10 }, () => fetchJwks(fresh.baseUrl)));
      expect(new Set(results.map((result) => result.text)).size).toBe(1);
    } finally {
      await fresh.stop();
    }
  });

  test("only the JWKS, discovery, and userinfo routes set Access-Control-Allow-Origin", async () => {
    for (const path of ["/__admin/health", "/oauth/token", "/v3.0/anything", "/no/such/path"]) {
      const response = await fetch(`${server.baseUrl}${path}`);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  test("a POST is not routed and answers in the OAuth error shape", async () => {
    const response = await fetch(`${server.baseUrl}/oauth/jwks`, { method: "POST" });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(
      '{"error":"invalid_request","error_description":"Not found"}',
    );
  });
});
