import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { startTestServer, type TestServer } from "./harness";
import { authorizeUrl, CLIENTS, userIds } from "./helpers/oauth";

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
});

/**
 * The document https://orcid.org/.well-known/openid-configuration answered on 2026-10-01, verbatim
 * (826 bytes, LF line endings, no trailing newline), with its base URL replaced by `base`.
 * It is written out here, not built by the code under test, so a change to the document's bytes
 * fails this test.
 */
function observedDiscovery(base: string): string {
  return `{
  "token_endpoint_auth_signing_alg_values_supported" : [ "RS256" ],
  "id_token_signing_alg_values_supported" : [ "RS256" ],
  "userinfo_endpoint" : "${base}/oauth/userinfo",
  "authorization_endpoint" : "${base}/oauth/authorize",
  "token_endpoint" : "${base}/oauth/token",
  "jwks_uri" : "${base}/oauth/jwks",
  "claims_supported" : [ "family_name", "given_name", "name", "auth_time", "iss", "sub" ],
  "scopes_supported" : [ "openid" ],
  "subject_types_supported" : [ "public" ],
  "response_types_supported" : [ "code", "id_token", "id_token token" ],
  "claims_parameter_supported" : false,
  "token_endpoint_auth_methods_supported" : [ "client_secret_post" ],
  "grant_types_supported" : [ "authorization_code", "implicit", "refresh_token" ],
  "issuer" : "${base}"
}`;
}

describe("GET /.well-known/openid-configuration", () => {
  test("is ORCID's document, byte for byte, built from the public base URL", async () => {
    const response = await fetch(`${server.baseUrl}/.well-known/openid-configuration`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(observedDiscovery(server.publicBaseUrl));
  });

  test("keeps a path prefix in every URL and strips a trailing slash from the issuer", async () => {
    const prefixed = await startTestServer({ publicBaseUrl: "https://mock.example.test/orcid/" });
    try {
      const response = await fetch(`${prefixed.baseUrl}/.well-known/openid-configuration`);
      const text = await response.text();
      expect(text).toBe(observedDiscovery("https://mock.example.test/orcid"));
      expect(text).toContain('"issuer" : "https://mock.example.test/orcid"\n');
    } finally {
      await prefixed.stop();
    }
  });

  test("ignores the Host header: every URL derives from the configured base", async () => {
    const response = await fetch(`${server.baseUrl}/.well-known/openid-configuration`, {
      headers: { host: "elsewhere.example.test", "x-forwarded-host": "elsewhere.example.test" },
    });
    expect(await response.text()).toBe(observedDiscovery(server.publicBaseUrl));
  });

  test("is JSON with ORCID's content type and CORS, and no other CORS header", async () => {
    const response = await fetch(`${server.baseUrl}/.well-known/openid-configuration`);
    expect(response.headers.get("content-type")).toBe("application/json;charset=UTF-8");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  test("its jwks_uri serves the key", async () => {
    const config = (await (
      await fetch(`${server.baseUrl}/.well-known/openid-configuration`)
    ).json()) as { jwks_uri: string };
    const response = await fetch(config.jwks_uri);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { keys: unknown[] }).keys).toHaveLength(1);
  });

  // The document advertises the implicit flow, as ORCID's does; this mock does not implement it,
  // so each advertised response type other than `code` is refused at the authorize endpoint.
  test("every response type it advertises except code is refused at authorize", async () => {
    const config = (await (
      await fetch(`${server.baseUrl}/.well-known/openid-configuration`)
    ).json()) as { response_types_supported: string[] };
    const unimplemented = config.response_types_supported.filter((type) => type !== "code");
    expect(unimplemented).toEqual(["id_token", "id_token token"]);
    const ids = await userIds(server);
    for (const response_type of unimplemented) {
      const response = await fetch(
        authorizeUrl(server.baseUrl, {
          client_id: CLIENTS.public.client_id,
          response_type,
          scope: "openid",
          redirect_uri: CLIENTS.public.redirectUri,
          login_as: ids.alder,
        }),
        { redirect: "manual" },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        `${CLIENTS.public.redirectUri}#error=unsupported_response_type`,
      );
    }
  });
});
