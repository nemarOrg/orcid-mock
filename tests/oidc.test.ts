import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createRemoteJWKSet, decodeProtectedHeader, errors, jwtVerify } from "jose";
import { startTestServer, type TestServer } from "./harness";
import {
  authorizeAs,
  authorizeUrl,
  CLIENTS,
  clientCredentials,
  exchangeCode,
  obtainToken,
  refreshTokens,
  type StarterIds,
  type TokenResponse,
  userIds,
} from "./helpers/oauth";

let server: TestServer;
let ids: StarterIds;
beforeAll(async () => {
  server = await startTestServer();
}, 10_000);
beforeEach(async () => {
  await server.reset();
  ids = await userIds(server);
});
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

/** The two halves of a compact JWT as text, so key order and bytes can be asserted. */
function jwtParts(jwt: string): { header: string; payload: string } {
  const [header, payload] = jwt.split(".");
  return {
    header: Buffer.from(header ?? "", "base64url").toString("utf8"),
    payload: Buffer.from(payload ?? "", "base64url").toString("utf8"),
  };
}

/** Verifies an ID token the way a relying party does: the JWKS from the discovery document. */
async function verifyIdToken(
  from: TestServer,
  idToken: string,
  expected: { issuer: string; audience: string },
) {
  const config = (await (
    await fetch(`${from.baseUrl}/.well-known/openid-configuration`)
  ).json()) as { jwks_uri: string };
  // The discovery document names the public base URL, which differs from `from.baseUrl` only
  // when a test sets a public base URL that is not reachable; those tests fetch from baseUrl.
  const jwksUrl = new URL(config.jwks_uri.replace(from.publicBaseUrl, from.baseUrl));
  return jwtVerify(idToken, createRemoteJWKSet(jwksUrl), expected);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID_TOKEN_KEYS = ["aud", "sub", "auth_time", "iss", "exp", "iat", "jti", "at_hash"];

/** A code flow with `openid`; the ID token is always there, so the type says so. */
async function openidToken(opts: {
  orcid: string;
  scope?: string;
  client?: "public" | "member";
  nonce?: string;
  on?: TestServer;
}): Promise<TokenResponse & { id_token: string }> {
  const token = await obtainToken(opts.on ?? server, {
    orcid: opts.orcid,
    scope: opts.scope ?? "openid",
    ...(opts.client === undefined ? {} : { client: opts.client }),
    ...(opts.nonce === undefined ? {} : { nonce: opts.nonce }),
  });
  if (token.id_token === undefined) throw new Error("the openid exchange returned no id_token");
  return token as TokenResponse & { id_token: string };
}

describe("the id_token", () => {
  test("verifies against the JWKS the discovery document names, with iss and aud checked", async () => {
    const token = await openidToken({ orcid: ids.alder });
    const { payload, protectedHeader } = await verifyIdToken(server, token.id_token, {
      issuer: server.publicBaseUrl,
      audience: CLIENTS.public.client_id,
    });
    expect(protectedHeader.alg).toBe("RS256");
    expect(payload.sub).toBe(ids.alder);
  });

  test("the protected header is exactly kid then alg, with no typ", async () => {
    const token = await openidToken({ orcid: ids.alder });
    const { keys } = await fetchJwks();
    const { header } = jwtParts(token.id_token);
    expect(header).toBe(`{"kid":"${keys[0]?.kid}","alg":"RS256"}`);
    expect(Object.keys(decodeProtectedHeader(token.id_token))).toEqual(["kid", "alg"]);
  });

  test("the claims, their types, and their order, for a public client and a public name", async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await openidToken({ orcid: ids.alder, nonce: "n-0S6_WzA2Mj" });
    const after = Math.floor(Date.now() / 1000);
    const { payload: text } = jwtParts(token.id_token);
    const claims = JSON.parse(text) as Record<string, unknown>;

    expect(Object.keys(claims)).toEqual([
      "aud",
      "sub",
      "auth_time",
      "iss",
      "exp",
      "iat",
      "nonce",
      "jti",
      "at_hash",
      "given_name",
      "family_name",
      "name",
    ]);
    // The client id as a string, not an array.
    expect(claims.aud).toBe(CLIENTS.public.client_id);
    expect(claims.sub).toBe(ids.alder);
    expect(claims.iss).toBe(server.publicBaseUrl);
    expect(claims.nonce).toBe("n-0S6_WzA2Mj");
    expect(claims.jti).toMatch(UUID);
    expect(claims).toMatchObject({
      given_name: "Alder",
      family_name: "Fennimore",
      name: "A. Fennimore",
    });
    // Integer seconds.
    for (const claim of ["auth_time", "exp", "iat"] as const) {
      expect(Number.isInteger(claims[claim])).toBe(true);
    }
    expect(claims.iat as number).toBeGreaterThanOrEqual(before);
    expect(claims.iat as number).toBeLessThanOrEqual(after);
    // The sign-in happened inside this test too.
    expect(claims.auth_time as number).toBeGreaterThanOrEqual(before);
    expect(claims.auth_time as number).toBeLessThanOrEqual(claims.iat as number);
  });

  test("lasts 24 hours", async () => {
    const token = await openidToken({ orcid: ids.alder });
    const claims = JSON.parse(jwtParts(token.id_token).payload) as { exp: number; iat: number };
    expect(claims.exp - claims.iat).toBe(86400);
  });

  test("the admin clock never shifts an emitted time", async () => {
    await server.admin("POST", "/clock", { advance_seconds: 7 * 24 * 3600 });
    const before = Math.floor(Date.now() / 1000);
    const token = await openidToken({ orcid: ids.alder });
    const claims = JSON.parse(jwtParts(token.id_token).payload) as Record<string, number>;
    for (const claim of ["iat", "auth_time"] as const) {
      expect(Math.abs((claims[claim] as number) - before)).toBeLessThanOrEqual(5);
    }
    expect((claims.exp as number) - before).toBeLessThanOrEqual(86400 + 5);
  });

  test("amr is the string pwd for a member client and absent for a public one", async () => {
    const member = await openidToken({ orcid: ids.alder, client: "member" });
    const memberClaims = JSON.parse(jwtParts(member.id_token).payload) as Record<string, unknown>;
    expect(memberClaims.amr).toBe("pwd");
    expect(memberClaims.aud).toBe(CLIENTS.member.client_id);
    // Right after auth_time, as in ORCID's printed example.
    expect(Object.keys(memberClaims).slice(0, 4)).toEqual(["aud", "sub", "auth_time", "amr"]);

    const publicClient = await openidToken({ orcid: ids.alder });
    expect(JSON.parse(jwtParts(publicClient.id_token).payload)).not.toHaveProperty("amr");
  });

  test("nonce is echoed when the authorize request had one and absent when it had none", async () => {
    const withNonce = await openidToken({ orcid: ids.alder, nonce: "xyz 123/+=" });
    expect(JSON.parse(jwtParts(withNonce.id_token).payload).nonce).toBe("xyz 123/+=");
    const without = await openidToken({ orcid: ids.alder });
    expect(JSON.parse(jwtParts(without.id_token).payload)).not.toHaveProperty("nonce");
  });

  test("at_hash is the base64url of the left half of the access token's SHA-256", async () => {
    const token = await openidToken({ orcid: ids.alder });
    const digest = createHash("sha256").update(token.access_token, "ascii").digest();
    const expected = digest.subarray(0, 16).toString("base64url");
    expect(JSON.parse(jwtParts(token.id_token).payload).at_hash).toBe(expected);
    expect(expected).toHaveLength(22);
  });

  test("every token has its own jti", async () => {
    const a = await openidToken({ orcid: ids.alder });
    const b = await openidToken({ orcid: ids.alder });
    expect(JSON.parse(jwtParts(a.id_token).payload).jti).not.toBe(
      JSON.parse(jwtParts(b.id_token).payload).jti,
    );
  });

  test("name claims are the fields of a public name that exist, and nothing for a private name", async () => {
    const claimsFor = async (orcid: string) =>
      JSON.parse(jwtParts((await openidToken({ orcid })).id_token).payload) as Record<
        string,
        unknown
      >;
    const names = (claims: Record<string, unknown>) =>
      Object.keys(claims).filter((key) => ["given_name", "family_name", "name"].includes(key));

    // Public name with no family name and no credit name: only the given name.
    const sennet = await claimsFor(ids.sennet);
    expect(names(sennet)).toEqual(["given_name"]);
    expect(sennet.given_name).toBe("Sennet");

    const create = async (name: Record<string, unknown>) => {
      const created = await server.admin<{ orcid: string }>("POST", "/users", { name });
      expect(created.status).toBe(201);
      return created.body.orcid;
    };
    // Given and family names but no credit name.
    const plain = await claimsFor(
      await create({ given_names: "Plain", family_name: "Person", visibility: "public" }),
    );
    expect(names(plain)).toEqual(["given_name", "family_name"]);
    // A blank credit name is not a credit name.
    const blank = await claimsFor(
      await create({ given_names: "Blank", credit_name: "  ", visibility: "public" }),
    );
    expect(names(blank)).toEqual(["given_name"]);
    // A private name shares none of its fields, and limited is not public.
    for (const visibility of ["private", "limited"]) {
      const hidden = await claimsFor(
        await create({
          given_names: "Quiet",
          family_name: "Person",
          credit_name: "Q. Person",
          visibility,
        }),
      );
      expect(names(hidden)).toEqual([]);
      expect(Object.keys(hidden)).toEqual(ID_TOKEN_KEYS);
    }
  });

  test("id_token is the last key of the response, after orcid", async () => {
    const authorized = await authorizeAs(server, { orcid: ids.alder, scope: "openid" });
    const reply = await exchangeCode(server, { code: authorized.code });
    expect(Object.keys(reply.json ?? {})).toEqual([
      "access_token",
      "token_type",
      "refresh_token",
      "expires_in",
      "scope",
      "name",
      "orcid",
      "id_token",
    ]);
    expect(reply.text).toMatch(/,"orcid":"[0-9X-]+","id_token":"[\w-]+\.[\w-]+\.[\w-]+"\}$/);
  });

  test("scope openid among others still returns one", async () => {
    const token = await openidToken({
      orcid: ids.alder,
      scope: "/read-limited openid /authenticate",
      client: "member",
    });
    expect(token.scope).toBe("/read-limited openid /authenticate");
    expect(token.id_token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  test("iss is the public base URL, path prefix included, not the address the request used", async () => {
    const prefixed = await startTestServer({ publicBaseUrl: "https://mock.example.test/orcid/" });
    try {
      const token = await openidToken({ orcid: (await userIds(prefixed)).alder, on: prefixed });
      const jwks = createRemoteJWKSet(new URL(`${prefixed.baseUrl}/oauth/jwks`));
      const { payload } = await jwtVerify(token.id_token, jwks, {
        issuer: "https://mock.example.test/orcid",
        audience: CLIENTS.public.client_id,
      });
      expect(payload.iss).toBe("https://mock.example.test/orcid");
    } finally {
      await prefixed.stop();
    }
  });

  test("the signing key survives a reset, so an earlier token still verifies", async () => {
    const token = await openidToken({ orcid: ids.alder });
    await server.reset();
    await verifyIdToken(server, token.id_token, {
      issuer: server.publicBaseUrl,
      audience: CLIENTS.public.client_id,
    });
  });

  test("another server's key does not verify it, and a wrong audience or issuer fails", async () => {
    const token = await openidToken({ orcid: ids.alder });
    const other = await startTestServer();
    try {
      await expect(
        verifyIdToken(other, token.id_token, {
          issuer: server.publicBaseUrl,
          audience: CLIENTS.public.client_id,
        }),
      ).rejects.toBeInstanceOf(errors.JWKSNoMatchingKey);
    } finally {
      await other.stop();
    }
    await expect(
      verifyIdToken(server, token.id_token, {
        issuer: server.publicBaseUrl,
        audience: CLIENTS.member.client_id,
      }),
    ).rejects.toBeInstanceOf(errors.JWTClaimValidationFailed);
    await expect(
      verifyIdToken(server, token.id_token, {
        issuer: "https://orcid.org",
        audience: CLIENTS.public.client_id,
      }),
    ).rejects.toBeInstanceOf(errors.JWTClaimValidationFailed);
  });

  test("a server's first exchanges and JWKS reads, fired together, all agree on one key", async () => {
    const fresh = await startTestServer();
    try {
      const freshIds = await userIds(fresh);
      // Codes need no key, so these can be issued first and exchanged together.
      const codes = await Promise.all(
        Array.from({ length: 5 }, () =>
          authorizeAs(fresh, { orcid: freshIds.alder, scope: "openid" }),
        ),
      );
      const [exchanges, jwks] = await Promise.all([
        Promise.all(codes.map((issued) => exchangeCode(fresh, { code: issued.code }))),
        Promise.all(Array.from({ length: 5 }, () => fetchJwks(fresh.baseUrl))),
      ]);
      expect(new Set(jwks.map((result) => result.text)).size).toBe(1);
      const published = jwks[0]?.keys[0];
      for (const exchange of exchanges) {
        expect(exchange.status).toBe(200);
        const idToken = (exchange.json as unknown as TokenResponse).id_token as string;
        expect(decodeProtectedHeader(idToken).kid).toBe(published?.kid);
        await verifyIdToken(fresh, idToken, {
          issuer: fresh.publicBaseUrl,
          audience: CLIENTS.public.client_id,
        });
      }
    } finally {
      await fresh.stop();
    }
  });
});

describe("no id_token", () => {
  test("without the openid scope", async () => {
    for (const scope of ["/authenticate", "/read-limited /authenticate"]) {
      const token = await obtainToken(server, { orcid: ids.alder, scope, client: "member" });
      expect(token).not.toHaveProperty("id_token");
    }
  });

  test("on a refresh, even of an openid token", async () => {
    const original = await openidToken({ orcid: ids.alder });
    const reply = await refreshTokens(server, { refreshToken: original.refresh_token });
    expect(reply.status).toBe(200);
    expect(reply.json?.scope).toBe("openid");
    expect(reply.json).not.toHaveProperty("id_token");
  });

  test("on client credentials", async () => {
    const reply = await clientCredentials(server);
    expect(reply.status).toBe(200);
    expect(reply.json).not.toHaveProperty("id_token");
  });
});
