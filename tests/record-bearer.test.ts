// How the record API reads a bearer token: the header, the `access_token` parameter, the one
// validity rule, the 401 for a bad token, and which reader sees `limited` items. These cases moved
// here from a phase 2 test that served the bearer helpers through a probe route; every token comes
// from the real token endpoint, and every check is a request to a real /v3.0 route.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { IDS, RECORD_USERS_FILE } from "./fixtures/record";
import { startTestServer, type TestServer } from "./harness";
import {
  authorizeAs,
  clientCredentials,
  clientFields,
  obtainToken,
  postForm,
  refreshTokens,
  type TokenResponse,
} from "./helpers/oauth";
import { getRecord, RECORD_HEADERS, type RecordReply } from "./helpers/record";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer({ users: RECORD_USERS_FILE });
}, 10_000);
beforeEach(() => server.reset());
afterAll(() => server.stop());

const RICH_EMAIL = `/v3.0/${IDS.rich}/email`;
const PUBLIC_ONLY = ["marisol.quenby@example.test"];
const WITH_LIMITED = ["marisol.quenby@example.test", "marisol.limited@example.test"];

const emailsOf = (reply: RecordReply): string[] =>
  (reply.json as { email: Array<{ email: string }> }).email.map((item) => item.email);

const memberToken = (orcid = IDS.rich, scope = "/read-limited"): Promise<TokenResponse> =>
  obtainToken(server, { orcid, scope, client: "member" });

const advance = (seconds: number) => server.admin("POST", "/clock", { advance_seconds: seconds });
const revoke = (token: string) =>
  postForm(server, "/oauth/revoke", { ...clientFields("member"), token });

describe("who sees limited items", () => {
  test("anonymous: public items only", async () => {
    expect(emailsOf(await getRecord(server, RICH_EMAIL))).toEqual(PUBLIC_ONLY);
  });

  test("a member client's /read-limited token for the same iD: public and limited", async () => {
    const token = await memberToken();
    expect(emailsOf(await getRecord(server, RICH_EMAIL, { token: token.access_token }))).toEqual(
      WITH_LIMITED,
    );
  });

  test("private is never served, to anyone", async () => {
    const token = await memberToken();
    const reply = await getRecord(server, RICH_EMAIL, { token: token.access_token });
    expect(JSON.stringify(reply.json)).not.toContain("marisol.private@example.test");
  });

  test("the same token on another iD is the public view (orcid-mock choice)", async () => {
    const token = await memberToken();
    // The all-private user's only email is limited: a limited reader of that record would see it.
    const reply = await getRecord(server, `/v3.0/${IDS.allPrivate}/email`, {
      token: token.access_token,
    });
    expect(reply.status).toBe(200);
    expect(emailsOf(reply)).toEqual([]);
  });

  test("a public client's token is the public view", async () => {
    const token = await obtainToken(server, {
      orcid: IDS.rich,
      scope: "/authenticate",
      client: "public",
    });
    expect(emailsOf(await getRecord(server, RICH_EMAIL, { token: token.access_token }))).toEqual(
      PUBLIC_ONLY,
    );
  });

  test("a member client's token without /read-limited is the public view", async () => {
    const token = await memberToken(IDS.rich, "/authenticate");
    expect(emailsOf(await getRecord(server, RICH_EMAIL, { token: token.access_token }))).toEqual(
      PUBLIC_ONLY,
    );
  });

  test("a client-credentials token has no user, so it is the public view and not an error", async () => {
    const reply = await clientCredentials(server, { client: "member" });
    const read = await getRecord(server, RICH_EMAIL, { token: String(reply.json?.access_token) });
    expect(read.status).toBe(200);
    expect(emailsOf(read)).toEqual(PUBLIC_ONLY);
  });
});

describe("reading the token", () => {
  test("the scheme is case-insensitive and the token is trimmed", async () => {
    const { access_token: token } = await memberToken();
    for (const header of [
      `bearer ${token}`,
      `BEARER ${token}`,
      `Bearer    ${token}`,
      `  Bearer ${token}  `,
    ]) {
      const reply = await getRecord(server, RICH_EMAIL, { headers: { authorization: header } });
      expect(emailsOf(reply)).toEqual(WITH_LIMITED);
    }
  });

  test("no header, another scheme, or a scheme with no token presents nothing", async () => {
    for (const header of ["Basic Zm9vOmJhcg==", "Bearer", "Bearer   ", "Token abc", ""]) {
      const reply = await getRecord(server, RICH_EMAIL, { headers: { authorization: header } });
      expect(reply.status).toBe(200);
      expect(emailsOf(reply)).toEqual(PUBLIC_ONLY);
    }
  });

  test("the access_token parameter is read when there is no header, by the same rule", async () => {
    const { access_token: token, refresh_token: refresh } = await memberToken();
    const good = await getRecord(server, `${RICH_EMAIL}?access_token=${encodeURIComponent(token)}`);
    expect(emailsOf(good)).toEqual(WITH_LIMITED);

    for (const bad of ["unknown", refresh]) {
      const reply = await getRecord(
        server,
        `${RICH_EMAIL}?access_token=${encodeURIComponent(bad)}`,
      );
      expect(reply.status).toBe(401);
      expect(reply.json).toEqual({
        error: "invalid_token",
        error_description: `Invalid access token: ${bad}`,
      });
    }
  });

  test("a blank access_token is no token, as in ORCID's filter", async () => {
    for (const query of ["access_token=", "access_token=%20%20"]) {
      const reply = await getRecord(server, `${RICH_EMAIL}?${query}`);
      expect(reply.status).toBe(200);
      expect(emailsOf(reply)).toEqual(PUBLIC_ONLY);
    }
  });

  test("the header wins over the parameter", async () => {
    const { access_token: token } = await memberToken();
    const good = await getRecord(server, `${RICH_EMAIL}?access_token=bad`, { token });
    expect(emailsOf(good)).toEqual(WITH_LIMITED);
    const bad = await getRecord(server, `${RICH_EMAIL}?access_token=${encodeURIComponent(token)}`, {
      token: "bad",
    });
    expect(bad.status).toBe(401);
  });
});

describe("a token that is not good is a 401 on every path", () => {
  test("an unknown token, and a refresh token, are invalid", async () => {
    const token = await memberToken();
    for (const presented of ["00000000-0000-4000-8000-000000000000", token.refresh_token, "x y"]) {
      const reply = await getRecord(server, RICH_EMAIL, { token: presented });
      expect(reply.status).toBe(401);
    }
  });

  test("the body, key order, Content-Type, and missing WWW-Authenticate are ORCID's", async () => {
    const presented = "00000000-0000-4000-8000-000000000000";
    const reply = await getRecord(server, RICH_EMAIL, { token: presented });
    expect(reply.status).toBe(401);
    expect(reply.headers.get("www-authenticate")).toBeNull();
    expect(reply.headers.get("content-type")).toBe("application/json;charset=UTF-8");
    expect(reply.text).toBe(
      `{"error":"invalid_token","error_description":"Invalid access token: ${presented}"}`,
    );
    for (const [name, value] of Object.entries(RECORD_HEADERS)) {
      expect(reply.headers.get(name)).toBe(value);
    }
  });

  test("the trimmed token is echoed exactly, whatever it holds", async () => {
    const reply = await getRecord(server, RICH_EMAIL, {
      headers: { authorization: 'Bearer  <b>"quoted"</b>  ' },
    });
    expect(reply.status).toBe(401);
    expect(reply.json).toEqual({
      error: "invalid_token",
      error_description: 'Invalid access token: <b>"quoted"</b>',
    });
  });

  test("routed or not, and for any method or Accept: the filter runs before the router", async () => {
    for (const [path, opts] of [
      ["/v3.0/", {}],
      [`/v3.0/${IDS.rich}/bogus`, {}],
      [`/v3.0/${IDS.rich}/record`, { accept: "text/csv" }],
      [`/v3.0/${IDS.rich}/email`, { method: "POST" }],
      ["/v3.0/0000-0000-0000-0000/email", {}],
      [`/v3.0/${IDS.deprecated}/email`, {}],
    ] as const) {
      const reply = await getRecord(server, path, { ...opts, token: "bad" });
      expect(reply.status).toBe(401);
      expect(reply.json).toEqual({
        error: "invalid_token",
        error_description: "Invalid access token: bad",
      });
    }
  });

  test("a revoked token is invalid, whether the access or the refresh token was revoked", async () => {
    for (const which of ["access_token", "refresh_token"] as const) {
      const token = await memberToken();
      expect((await revoke(token[which])).status).toBe(200);
      expect((await getRecord(server, RICH_EMAIL, { token: token.access_token })).status).toBe(401);
    }
  });

  test("a token is good for twenty years of server time, then it expires", async () => {
    const token = await memberToken();
    // Ten seconds inside the twenty years, so a slow runner cannot tip it over.
    await advance(631138509);
    expect((await getRecord(server, RICH_EMAIL, { token: token.access_token })).status).toBe(200);
    await advance(21);
    expect((await getRecord(server, RICH_EMAIL, { token: token.access_token })).status).toBe(401);
  });

  test("refreshing revokes the old access token unless revoke_old is false", async () => {
    const revoked = await memberToken();
    const next = await refreshTokens(server, {
      refreshToken: revoked.refresh_token,
      client: "member",
    });
    expect((await getRecord(server, RICH_EMAIL, { token: revoked.access_token })).status).toBe(401);
    expect(
      (await getRecord(server, RICH_EMAIL, { token: String(next.json?.access_token) })).status,
    ).toBe(200);

    const kept = await memberToken();
    const nextKept = await refreshTokens(server, {
      refreshToken: kept.refresh_token,
      client: "member",
      extra: { revoke_old: "false" },
    });
    expect((await getRecord(server, RICH_EMAIL, { token: kept.access_token })).status).toBe(200);
    expect(
      (await getRecord(server, RICH_EMAIL, { token: String(nextKept.json?.access_token) })).status,
    ).toBe(200);
  });

  test("reset forgets every token", async () => {
    const token = await memberToken();
    await server.reset();
    expect((await getRecord(server, RICH_EMAIL, { token: token.access_token })).status).toBe(401);
  });

  test("an authorization code is not a token", async () => {
    const { code } = await authorizeAs(server, {
      orcid: IDS.rich,
      scope: "/read-limited",
      client: "member",
    });
    expect((await getRecord(server, RICH_EMAIL, { token: code })).status).toBe(401);
  });
});
