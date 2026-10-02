// resolveBearer and invalidTokenResponse have no route of their own until phases 3 and 4, so this
// file builds the real app (src/bootstrap.ts, the real MemoryStore, the real OAuth routes), adds
// one probe route that calls them the way those phases will, and serves it on a real socket. Every
// token below comes from the real token endpoint, and every check is an HTTP request.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createMockApp } from "../src/bootstrap";
import { STARTER_USERS_FILE } from "../src/fixtures/starter";
import { silentLogger } from "../src/log";
import {
  checkAccessToken,
  invalidTokenResponse,
  parseBearerHeader,
  resolveBearer,
} from "../src/oauth/bearer";
import {
  authorizeAs,
  clientCredentials,
  obtainToken,
  refreshTokens,
  type TokenResponse,
} from "./helpers/oauth";

let baseUrl: string;
let stop: () => void;
let aldersId: string;

beforeAll(async () => {
  const config = { publicBaseUrl: "http://127.0.0.1:0", logLevel: "error" as const };
  const { app, store } = await createMockApp({
    users: STARTER_USERS_FILE,
    config,
    nowMs: Date.now(),
    log: silentLogger,
  });
  app.get("/probe", async (c) => {
    const result = await resolveBearer(c, store);
    if (result.kind === "invalid") return invalidTokenResponse(c, result.presented);
    if (result.kind === "none") return c.json({ kind: "none" });
    const { token } = result;
    return c.json({
      kind: "ok",
      orcid: token.orcid,
      scopes: token.scopes,
      client: token.client_id,
    });
  });
  // The route a form or query-parameter caller would write: the token comes from somewhere other
  // than the header, and the one validity rule is checkAccessToken.
  app.get("/probe-param", async (c) => {
    const result = await checkAccessToken(store, c.req.query("access_token") ?? "");
    return result.kind === "invalid"
      ? invalidTokenResponse(c, result.presented)
      : c.json({ kind: "ok", orcid: result.token.orcid });
  });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  baseUrl = `http://127.0.0.1:${server.port}`;
  config.publicBaseUrl = baseUrl;
  stop = () => server.stop(true);
}, 10_000);

beforeEach(async () => {
  await fetch(`${baseUrl}/__admin/reset`, { method: "POST" });
  const users = (await (await fetch(`${baseUrl}/__admin/users`)).json()) as Array<{
    orcid: string;
    name: { given_names: string };
  }>;
  aldersId = users.find((user) => user.name.given_names === "Alder")?.orcid ?? "";
});
afterAll(() => stop());

const reachable = () => ({ baseUrl });
const probe = (authorization?: string) =>
  fetch(`${baseUrl}/probe`, authorization === undefined ? {} : { headers: { authorization } });
const advance = (seconds: number) =>
  fetch(`${baseUrl}/__admin/clock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ advance_seconds: seconds }),
  });
const signIn = (scope = "/authenticate"): Promise<TokenResponse> =>
  obtainToken(reachable(), { orcid: aldersId, scope });

describe("resolveBearer", () => {
  test("a live access token resolves, with its user, scopes, and client", async () => {
    const token = await signIn("openid /authenticate");
    const response = await probe(`Bearer ${token.access_token}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kind: "ok",
      orcid: aldersId,
      scopes: ["openid", "/authenticate"],
      client: "APP-ORCIDMOCK000001",
    });
  });

  test("the scheme is case-insensitive and the token is trimmed", async () => {
    const { access_token: token } = await signIn();
    for (const header of [
      `bearer ${token}`,
      `BEARER ${token}`,
      `Bearer    ${token}`,
      `  Bearer ${token}  `,
    ]) {
      const response = await probe(header);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ kind: "ok" });
    }
  });

  test("a client-credentials token resolves with no user", async () => {
    const reply = await clientCredentials(reachable());
    const response = await probe(`Bearer ${String(reply.json?.access_token)}`);
    expect(await response.json()).toMatchObject({
      kind: "ok",
      orcid: null,
      scopes: ["/read-public"],
    });
  });

  test("no header, another scheme, or a scheme with no token presents nothing", async () => {
    for (const header of [
      undefined,
      "Basic Zm9vOmJhcg==",
      "Bearer",
      "Bearer   ",
      "Token abc",
      "",
    ]) {
      const response = await probe(header);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ kind: "none" });
    }
  });

  test("an unknown token is invalid, and so is a refresh token", async () => {
    const token = await signIn();
    for (const presented of ["00000000-0000-4000-8000-000000000000", token.refresh_token, "x y"]) {
      const response = await probe(`Bearer ${presented}`);
      expect(response.status).toBe(401);
    }
  });

  test("a revoked token is invalid, whether the access or the refresh token was presented", async () => {
    for (const which of ["access_token", "refresh_token"] as const) {
      const token = await signIn();
      const revoke = await fetch(`${baseUrl}/oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: "APP-ORCIDMOCK000001",
          client_secret: "orcid-mock-secret",
          token: token[which],
        }),
      });
      expect(revoke.status).toBe(200);
      expect((await probe(`Bearer ${token.access_token}`)).status).toBe(401);
    }
  });

  test("a token is good for twenty years of server time, then it expires", async () => {
    const token = await signIn();
    // Ten seconds inside the twenty years, so a slow runner cannot tip it over.
    await advance(631138509);
    expect((await probe(`Bearer ${token.access_token}`)).status).toBe(200);
    await advance(21);
    expect((await probe(`Bearer ${token.access_token}`)).status).toBe(401);
  });

  test("refreshing revokes the old access token unless revoke_old is false", async () => {
    const revoked = await signIn();
    const next = await refreshTokens(reachable(), { refreshToken: revoked.refresh_token });
    expect((await probe(`Bearer ${revoked.access_token}`)).status).toBe(401);
    expect((await probe(`Bearer ${String(next.json?.access_token)}`)).status).toBe(200);

    const kept = await signIn();
    const nextKept = await refreshTokens(reachable(), {
      refreshToken: kept.refresh_token,
      extra: { revoke_old: "false" },
    });
    expect((await probe(`Bearer ${kept.access_token}`)).status).toBe(200);
    expect((await probe(`Bearer ${String(nextKept.json?.access_token)}`)).status).toBe(200);
  });

  test("reset forgets every token", async () => {
    const token = await signIn();
    await fetch(`${baseUrl}/__admin/reset`, { method: "POST" });
    expect((await probe(`Bearer ${token.access_token}`)).status).toBe(401);
  });

  test("a code is not a token", async () => {
    const { code } = await authorizeAs(reachable(), { orcid: aldersId, scope: "/authenticate" });
    expect((await probe(`Bearer ${code}`)).status).toBe(401);
  });
});

describe("checkAccessToken", () => {
  const probeParam = (token: string) =>
    fetch(`${baseUrl}/probe-param?access_token=${encodeURIComponent(token)}`);

  test("applies the same rule to a token found outside the header", async () => {
    const token = await signIn();
    const ok = await probeParam(token.access_token);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ kind: "ok", orcid: aldersId });

    for (const bad of ["", "unknown", token.refresh_token]) {
      const response = await probeParam(bad);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: "invalid_token",
        error_description: `Invalid access token: ${bad}`,
      });
    }

    await fetch(`${baseUrl}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "APP-ORCIDMOCK000001",
        client_secret: "orcid-mock-secret",
        token: token.access_token,
      }),
    });
    expect((await probeParam(token.access_token)).status).toBe(401);
  });
});

describe("invalidTokenResponse", () => {
  test("is 401 invalid_token with the presented token echoed, error first, and no WWW-Authenticate", async () => {
    const presented = "00000000-0000-4000-8000-000000000000";
    const response = await probe(`Bearer ${presented}`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(response.headers.get("content-type")).toBe("application/json;charset=UTF-8");
    expect(await response.text()).toBe(
      `{"error":"invalid_token","error_description":"Invalid access token: ${presented}"}`,
    );
  });

  test("echoes the trimmed token exactly, whatever it holds", async () => {
    const response = await probe('Bearer  <b>"quoted"</b>  ');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "invalid_token",
      error_description: 'Invalid access token: <b>"quoted"</b>',
    });
  });
});

// A pure function of a header string, so it is tested directly with real strings (the same cases
// are exercised over HTTP above).
describe("parseBearerHeader", () => {
  test("takes the token after a case-insensitive Bearer scheme and trims it", () => {
    expect(parseBearerHeader("Bearer abc")).toBe("abc");
    expect(parseBearerHeader("bearer abc")).toBe("abc");
    expect(parseBearerHeader("BEARER \t abc \t ")).toBe("abc");
    expect(parseBearerHeader("  Bearer abc")).toBe("abc");
    // Anything after the first run of whitespace is the token, inner spaces included.
    expect(parseBearerHeader("Bearer a b")).toBe("a b");
  });

  test("presents nothing without a header, a token, or the Bearer scheme", () => {
    for (const header of [
      undefined,
      "",
      " ",
      "Bearer",
      "Bearer ",
      "Bearer \t ",
      "Basic abc",
      "Bearerx abc",
      "abc",
      "Bearer",
    ]) {
      expect(parseBearerHeader(header)).toBeNull();
    }
  });

  test("a 64 KB run of spaces is answered at once, whatever follows it", () => {
    const spaces = " ".repeat(64 * 1024);
    const started = performance.now();
    expect(parseBearerHeader(`Bearer a${spaces}b`)).toBe(`a${spaces}b`);
    expect(parseBearerHeader(`Bearer${spaces}`)).toBeNull();
    expect(parseBearerHeader(`${spaces}Bearer a`)).toBe("a");
    expect(parseBearerHeader(`Bearer a${spaces}`)).toBe("a");
    // The regular expression this replaced needed about nine seconds for the first of these.
    expect(performance.now() - started).toBeLessThan(250);
  });
});
