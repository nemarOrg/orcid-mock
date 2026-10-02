import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createRemoteJWKSet, decodeProtectedHeader, errors, jwtVerify } from "jose";
import { startTestServer, type TestServer } from "./harness";
import {
  authorizeAs,
  authorizeUrl,
  CLIENTS,
  clientCredentials,
  clientFields,
  exchangeCode,
  obtainToken,
  postForm,
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

  test("carries ORCID's cache headers and a JSON content type", async () => {
    const { response } = await fetchJwks();
    expect(response.headers.get("content-type")).toBe("application/json;charset=UTF-8");
    expect(response.headers.get("cache-control")).toBe(
      "no-cache, no-store, max-age=0, must-revalidate",
    );
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("expires")).toBe("0");
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

  test("ten JWKS requests to a fresh server all return the same key", async () => {
    const fresh = await startTestServer();
    try {
      const results = await Promise.all(Array.from({ length: 10 }, () => fetchJwks(fresh.baseUrl)));
      expect(new Set(results.map((result) => result.text)).size).toBe(1);
    } finally {
      await fresh.stop();
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

  test("is JSON with ORCID's content type", async () => {
    const response = await fetch(`${server.baseUrl}/.well-known/openid-configuration`);
    expect(response.headers.get("content-type")).toBe("application/json;charset=UTF-8");
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

  test("auth_time is the sign-in, not the exchange: a silent re-authorization keeps it", async () => {
    const first = await authorizeAs(server, { orcid: ids.alder, scope: "openid" });
    expect(first.cookie).not.toBeNull();
    const firstToken = (await exchangeCode(server, { code: first.code })).json as unknown as {
      id_token: string;
    };
    // Long enough for a whole second to pass, so a clock read at the exchange would differ.
    await Bun.sleep(1200);
    const second = await authorizeAs(server, {
      orcid: ids.alder,
      scope: "openid",
      prompt: "none",
      cookie: first.cookie as string,
    });
    const secondToken = (await exchangeCode(server, { code: second.code })).json as unknown as {
      id_token: string;
    };
    const one = JSON.parse(jwtParts(firstToken.id_token).payload) as Record<string, number>;
    const two = JSON.parse(jwtParts(secondToken.id_token).payload) as Record<string, number>;
    expect(two.auth_time).toBe(one.auth_time as number);
    expect(two.auth_time as number).toBeLessThan(two.iat as number);
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

  test("id_tokens from a fresh server all verify against the one key it publishes", async () => {
    const fresh = await startTestServer();
    try {
      const freshIds = await userIds(fresh);
      // Codes need no key, so these can be issued first and exchanged together. Whether two first
      // uses can race to different keys is tested in signing-key.test.ts, where they can overlap.
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

const DENIED = '{"error":"access_denied","error-description":"access_token is invalid"}';

/** GET /oauth/userinfo with an optional bearer header. */
function getUserinfo(authorization?: string, from: TestServer = server, origin?: string) {
  const headers = {
    ...(authorization === undefined ? {} : { authorization }),
    ...(origin === undefined ? {} : { origin }),
  };
  return fetch(`${from.baseUrl}/oauth/userinfo`, { headers });
}

/** POST /oauth/userinfo with an optional form body and optional extra headers. */
function postUserinfo(opts: {
  form?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
}) {
  const hasForm = opts.form !== undefined;
  return fetch(`${server.baseUrl}/oauth/userinfo`, {
    method: "POST",
    headers: {
      ...(hasForm ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...opts.headers,
    },
    ...(hasForm ? { body: new URLSearchParams(opts.form) } : {}),
    ...(opts.body === undefined ? {} : { body: opts.body }),
  });
}

/** What userinfo answers for the starter users, as text, to compare bytes and key order. */
function userinfoText(
  orcid: string,
  names: { name: string | null; family: string | null; given: string | null },
  base: string = server.publicBaseUrl,
): string {
  return JSON.stringify({
    id: `${base}/${orcid}`,
    sub: orcid,
    name: names.name,
    family_name: names.family,
    given_name: names.given,
  });
}

const ALDER_NAMES = { name: "A. Fennimore", family: "Fennimore", given: "Alder" };

describe("GET /oauth/userinfo", () => {
  test("answers a /authenticate or an openid token with id, sub, and the public names, in order", async () => {
    for (const scope of ["/authenticate", "openid", "openid /read-limited"]) {
      const token = await obtainToken(server, { orcid: ids.alder, scope, client: "member" });
      const response = await getUserinfo(`Bearer ${token.access_token}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(userinfoText(ids.alder, ALDER_NAMES));
    }
  });

  test("carries ORCID's content type", async () => {
    const token = await obtainToken(server, { orcid: ids.alder, scope: "openid" });
    const response = await getUserinfo(`Bearer ${token.access_token}`);
    expect(response.headers.get("content-type")).toBe("application/json;charset=UTF-8");
  });

  test("writes null for a field that does not exist, and for every field of a private name", async () => {
    const sennet = await obtainToken(server, { orcid: ids.sennet, scope: "openid" });
    expect(await (await getUserinfo(`Bearer ${sennet.access_token}`)).text()).toBe(
      userinfoText(ids.sennet, { name: null, family: null, given: "Sennet" }),
    );

    const created = await server.admin<{ orcid: string }>("POST", "/users", {
      name: {
        given_names: "Quiet",
        family_name: "Person",
        credit_name: "Q. Person",
        visibility: "private",
      },
    });
    const quiet = await obtainToken(server, { orcid: created.body.orcid, scope: "/authenticate" });
    expect(await (await getUserinfo(`Bearer ${quiet.access_token}`)).text()).toBe(
      userinfoText(created.body.orcid, { name: null, family: null, given: null }),
    );
  });

  test("id is the iD under the public base URL, path prefix included", async () => {
    const prefixed = await startTestServer({ publicBaseUrl: "https://mock.example.test/orcid" });
    try {
      const alder = (await userIds(prefixed)).alder;
      const token = await obtainToken(prefixed, { orcid: alder, scope: "openid" });
      const response = await getUserinfo(`Bearer ${token.access_token}`, prefixed);
      expect(await response.text()).toBe(
        userinfoText(alder, ALDER_NAMES, "https://mock.example.test/orcid"),
      );
    } finally {
      await prefixed.stop();
    }
  });

  test("sub matches the id_token's sub and its names", async () => {
    const token = await obtainToken(server, { orcid: ids.alder, scope: "openid" });
    const claims = JSON.parse(jwtParts(token.id_token as string).payload) as Record<string, string>;
    const info = (await (await getUserinfo(`Bearer ${token.access_token}`)).json()) as Record<
      string,
      string
    >;
    expect(info.sub).toBe(claims.sub);
    expect(info.name).toBe(claims.name);
    expect(info.family_name).toBe(claims.family_name);
    expect(info.given_name).toBe(claims.given_name);
  });

  test("accepts the Bearer scheme in any case and trims the token", async () => {
    const token = await obtainToken(server, { orcid: ids.alder, scope: "openid" });
    for (const header of [`bearer ${token.access_token}`, `BEARER   ${token.access_token}  `]) {
      expect((await getUserinfo(header)).status).toBe(200);
    }
  });

  test("reads the header alone: an access_token in the query string is not a token", async () => {
    const token = await obtainToken(server, { orcid: ids.alder, scope: "openid" });
    const response = await fetch(
      `${server.baseUrl}/oauth/userinfo?access_token=${token.access_token}`,
    );
    expect(response.status).toBe(403);
  });

  test("a token whose user was deleted is as invalid as an unknown one", async () => {
    const created = await server.admin<{ orcid: string }>("POST", "/users", {
      name: { given_names: "Gone", visibility: "public" },
    });
    const token = await obtainToken(server, { orcid: created.body.orcid, scope: "openid" });
    expect((await getUserinfo(`Bearer ${token.access_token}`)).status).toBe(200);
    await server.admin("DELETE", `/users/${created.body.orcid}`);
    expect(await (await getUserinfo(`Bearer ${token.access_token}`)).text()).toBe(DENIED);
  });
});

describe("POST /oauth/userinfo", () => {
  test("reads the access_token form field", async () => {
    const token = await obtainToken(server, { orcid: ids.alder, scope: "openid" });
    const response = await postUserinfo({ form: { access_token: token.access_token } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(userinfoText(ids.alder, ALDER_NAMES));
    expect(response.headers.get("content-type")).toBe("application/json;charset=UTF-8");
  });

  test("falls back to the Authorization header, with or without a form body", async () => {
    const token = await obtainToken(server, { orcid: ids.alder, scope: "openid" });
    const headers = { authorization: `Bearer ${token.access_token}` };
    expect((await postUserinfo({ headers })).status).toBe(200);
    expect((await postUserinfo({ headers, form: { unrelated: "x" } })).status).toBe(200);
    expect((await postUserinfo({ headers, form: { access_token: "" } })).status).toBe(200);
  });

  test("a form token that is no good falls through to a header token that is", async () => {
    const good = await obtainToken(server, { orcid: ids.alder, scope: "openid" });
    const response = await postUserinfo({
      form: { access_token: "00000000-0000-4000-8000-000000000000" },
      headers: { authorization: `Bearer ${good.access_token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(userinfoText(ids.alder, ALDER_NAMES));
  });

  test("a good form token wins over a header token that is no good", async () => {
    const good = await obtainToken(server, { orcid: ids.alder, scope: "openid" });
    const response = await postUserinfo({
      form: { access_token: good.access_token },
      headers: { authorization: "Bearer 00000000-0000-4000-8000-000000000000" },
    });
    expect(response.status).toBe(200);
  });

  test("a form field is only read from a form-encoded body", async () => {
    const token = await obtainToken(server, { orcid: ids.alder, scope: "openid" });
    const asJson = await postUserinfo({
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ access_token: token.access_token }),
    });
    expect(await asJson.text()).toBe(DENIED);
    const withCharset = await postUserinfo({
      headers: { "content-type": "Application/X-WWW-Form-Urlencoded; charset=UTF-8" },
      body: `access_token=${token.access_token}`,
    });
    expect(withCharset.status).toBe(200);
  });
});

describe("POST /oauth/userinfo token sources", () => {
  const tokenFor = async (orcid: string) =>
    (await obtainToken(server, { orcid, scope: "openid" })).access_token;

  test("reads access_token from the query string, with or without a body", async () => {
    const token = await tokenFor(ids.alder);
    for (const init of [
      {},
      { headers: { "content-type": "application/json" }, body: "{}" },
      {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "unrelated=1",
      },
    ]) {
      const response = await fetch(`${server.baseUrl}/oauth/userinfo?access_token=${token}`, {
        method: "POST",
        ...init,
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(userinfoText(ids.alder, ALDER_NAMES));
    }
  });

  test("a query-string token comes before a form token, as a servlet's getParameter returns the first value", async () => {
    const fromQuery = await tokenFor(ids.alder);
    const fromForm = await tokenFor(ids.sennet);
    const response = await fetch(`${server.baseUrl}/oauth/userinfo?access_token=${fromQuery}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ access_token: fromForm }),
    });
    expect(await response.text()).toBe(userinfoText(ids.alder, ALDER_NAMES));
  });

  test("a bad query-string token falls through to the header, like a bad form token", async () => {
    const good = await tokenFor(ids.alder);
    const response = await fetch(
      `${server.baseUrl}/oauth/userinfo?access_token=00000000-0000-4000-8000-000000000000`,
      { method: "POST", headers: { authorization: `Bearer ${good}` } },
    );
    expect(response.status).toBe(200);
  });

  test("the form token comes before the header token, and each answers as its own user", async () => {
    const fromForm = await tokenFor(ids.alder);
    const fromHeader = await tokenFor(ids.sennet);
    const response = await postUserinfo({
      form: { access_token: fromForm },
      headers: { authorization: `Bearer ${fromHeader}` },
    });
    expect(await response.text()).toBe(userinfoText(ids.alder, ALDER_NAMES));
    // The other way round, to show the header is read at all.
    const other = await postUserinfo({
      form: { access_token: "00000000-0000-4000-8000-000000000000" },
      headers: { authorization: `Bearer ${fromHeader}` },
    });
    expect(await other.text()).toBe(
      userinfoText(ids.sennet, { name: null, family: null, given: "Sennet" }),
    );
  });
});

describe("userinfo refuses with ORCID's one 403", () => {
  /** Every way of presenting a token that must not work, as `[description, request]`. */
  async function refusals(): Promise<Array<[string, () => Promise<Response>]>> {
    const bearer = (token: string) => () => getUserinfo(`Bearer ${token}`);
    const live = await obtainToken(server, { orcid: ids.alder, scope: "openid" });

    const revoked = await obtainToken(server, { orcid: ids.alder, scope: "openid" });
    const revoke = await postForm(server, "/oauth/revoke", {
      ...clientFields(),
      token: revoked.access_token,
    });
    expect(revoke.status).toBe(200);

    const rotated = await obtainToken(server, { orcid: ids.alder, scope: "openid" });
    expect((await refreshTokens(server, { refreshToken: rotated.refresh_token })).status).toBe(200);

    const credentials = (await clientCredentials(server)).json as unknown as TokenResponse;
    const limitedOnly = await obtainToken(server, {
      orcid: ids.alder,
      scope: "/read-limited",
      client: "member",
    });
    return [
      ["no token at all", () => getUserinfo()],
      ["an unknown token", bearer("00000000-0000-4000-8000-000000000000")],
      ["a revoked token", bearer(revoked.access_token)],
      ["an access token that a refresh rotated out", bearer(rotated.access_token)],
      ["a refresh token", bearer(live.refresh_token)],
      ["a /read-public client-credentials token", bearer(credentials.access_token)],
      ["a /read-limited token, which has no /authenticate", bearer(limitedOnly.access_token)],
      ["a bearer header with nothing after it", () => getUserinfo("Bearer")],
      ["another scheme", () => getUserinfo(`Basic ${live.access_token}`)],
      ["the id_token in place of the access token", bearer(live.id_token as string)],
      [
        "a bad form token over POST",
        () => postUserinfo({ form: { access_token: "00000000-0000-4000-8000-000000000000" } }),
      ],
      ["a POST with nothing", () => postUserinfo({})],
    ];
  }

  test("for no token, an unknown, revoked, rotated, or wrong-kind token, and a scope without /authenticate", async () => {
    for (const [description, send] of await refusals()) {
      const response = await send();
      expect({ description, status: response.status }).toEqual({ description, status: 403 });
      expect({ description, body: await response.text() }).toEqual({ description, body: DENIED });
    }
  });

  test("with the hyphenated error-description key, error first, JSON, no WWW-Authenticate", async () => {
    const response = await getUserinfo();
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("application/json;charset=UTF-8");
    expect(response.headers.get("cache-control")).toBe(
      "no-cache, no-store, max-age=0, must-revalidate",
    );
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("expires")).toBe("0");
    expect(response.headers.get("www-authenticate")).toBeNull();
    const text = await response.text();
    expect(text).toBe('{"error":"access_denied","error-description":"access_token is invalid"}');
    expect(Object.keys(JSON.parse(text))).toEqual(["error", "error-description"]);
  });

  test("for an expired token", async () => {
    const token = await obtainToken(server, { orcid: ids.alder, scope: "openid" });
    expect((await getUserinfo(`Bearer ${token.access_token}`)).status).toBe(200);
    // Tokens last 631138519 seconds of server time.
    await server.admin("POST", "/clock", { advance_seconds: 631138519 });
    expect(await (await getUserinfo(`Bearer ${token.access_token}`)).text()).toBe(DENIED);
  });
});

// ORCID's cross-domain filter runs ahead of the controllers, for the three paths only: it echoes
// the request's Origin, sends Access-Control-Allow-Credentials: true always, and sends no
// Access-Control-Allow-Origin when the request has no Origin (see src/oidc/headers.ts).
describe("CORS", () => {
  const ORIGIN = "http://localhost:3000";
  const paths = ["/.well-known/openid-configuration", "/oauth/jwks", "/oauth/userinfo"];

  /** One request per route, covering the success answer and the 403. */
  async function answers(origin: string | undefined) {
    const headers: Record<string, string> = origin === undefined ? {} : { origin };
    const token = await obtainToken(server, { orcid: ids.alder, scope: "openid" });
    return [
      ...(await Promise.all(
        paths
          .slice(0, 2)
          .map(
            async (path) => [path, await fetch(`${server.baseUrl}${path}`, { headers })] as const,
          ),
      )),
      [
        "/oauth/userinfo (200)",
        await getUserinfo(`Bearer ${token.access_token}`, server, origin),
      ] as const,
      ["/oauth/userinfo (403)", await getUserinfo(undefined, server, origin)] as const,
      [
        "/oauth/userinfo (POST 200)",
        await postUserinfo({ form: { access_token: token.access_token }, headers }),
      ] as const,
    ];
  }

  test("a request with an Origin gets it echoed, with credentials allowed", async () => {
    for (const [name, response] of await answers(ORIGIN)) {
      expect({ name, origin: response.headers.get("access-control-allow-origin") }).toEqual({
        name,
        origin: ORIGIN,
      });
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
      expect(response.headers.get("vary")).toBeNull();
    }
  });

  test("a request with no Origin gets no Access-Control-Allow-Origin, as in ORCID's captures", async () => {
    for (const [name, response] of await answers(undefined)) {
      expect({ name, origin: response.headers.get("access-control-allow-origin") }).toEqual({
        name,
        origin: null,
      });
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
      expect(response.headers.get("vary")).toBeNull();
    }
  });

  test("an OPTIONS preflight with Access-Control-Request-Method is an empty 200 on the three routes", async () => {
    for (const path of paths) {
      const response = await fetch(`${server.baseUrl}${path}`, {
        method: "OPTIONS",
        headers: {
          origin: ORIGIN,
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      });
      expect({ path, status: response.status }).toEqual({ path, status: 200 });
      expect(await response.text()).toBe("");
      expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
      expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, PUT, DELETE");
      expect(response.headers.get("access-control-allow-headers")).toBe(
        "X-Requested-With,Origin,Content-Type,Accept,Authorization,x-csrf-token,x-xsrf-token",
      );
    }
  });

  test("no OAuth or admin route sends a CORS header, a preflight included", async () => {
    for (const path of ["/__admin/health", "/oauth/token", "/oauth/authorize", "/no/such/path"]) {
      for (const [method, extra] of [
        ["GET", {}],
        ["OPTIONS", { "access-control-request-method": "POST" }],
      ] as const) {
        const response = await fetch(`${server.baseUrl}${path}`, {
          method,
          headers: { origin: ORIGIN, ...extra },
        });
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
        expect(response.headers.get("access-control-allow-credentials")).toBeNull();
        if (method === "OPTIONS") {
          // The token endpoint answers any method with its 415; the rest are 404.
          expect({ path, answered: response.status === 200 }).toEqual({ path, answered: false });
        }
      }
    }
  });
});

// No OpenID Connect route reaches the generic 500 handler through a real request, so there is no
// 500 body to assert on. These pin that malformed input is always a 4xx or an answer, never a
// 5xx, so a change that lets one through fails here.
describe("malformed input never reaches a 5xx", () => {
  const WEIRD = ["%", "%E0%A4%A", "%FF%FE", "%0d%0a", "[", "\\", "a".repeat(10_000)];

  test("userinfo with Authorization headers and form bodies that are not tokens", async () => {
    for (const weird of WEIRD) {
      for (const authorization of [weird, `Bearer ${weird}`, `Bearer a${" ".repeat(5000)}b`]) {
        const response = await getUserinfo(authorization);
        expect(response.status).toBe(403);
        await response.arrayBuffer();
      }
      const posted = await fetch(`${server.baseUrl}/oauth/userinfo`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `access_token=${weird}&x=${weird}`,
      });
      expect(posted.status).toBe(403);
      await posted.arrayBuffer();
    }
    // Bytes that are not UTF-8, and a body with no content type at all.
    for (const body of [new Uint8Array([0xff, 0xfe, 0x3d, 0x80]), "=&=&&&", "access_token"]) {
      const response = await fetch(`${server.baseUrl}/oauth/userinfo`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new Blob([body]),
      });
      expect(response.status).toBe(403);
      await response.arrayBuffer();
    }
  });

  test("a long and a strange nonce are echoed in a token that still verifies", async () => {
    for (const nonce of ["n".repeat(4000), 'é日本 "quoted" \\ back\u0000nul', "😀"]) {
      const token = await openidToken({ orcid: ids.alder, nonce });
      const { payload } = await verifyIdToken(server, token.id_token, {
        issuer: server.publicBaseUrl,
        audience: CLIENTS.public.client_id,
      });
      expect(payload.nonce).toBe(nonce);
    }
  });

  test("discovery and the JWKS ignore query strings and bodies", async () => {
    for (const path of ["/.well-known/openid-configuration", "/oauth/jwks"]) {
      for (const weird of WEIRD) {
        const response = await fetch(`${server.baseUrl}${path}?x=${weird}&%=%`);
        expect(response.status).toBe(200);
        await response.arrayBuffer();
      }
    }
  });
});
