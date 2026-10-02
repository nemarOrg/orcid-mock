import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { startTestServer, type TestServer } from "./harness";
import {
  authorizeAs,
  basicAuth,
  CLIENTS,
  clientCredentials,
  exchangeCode,
  obtainToken,
  postForm,
  REDIRECT_URI,
  refreshTokens,
  tokenRequest,
  userIds,
} from "./helpers/oauth";

let server: TestServer;
let ids: Record<string, string>;
beforeAll(async () => {
  server = await startTestServer();
}, 10_000);
beforeEach(async () => {
  await server.reset();
  ids = await userIds(server);
});
afterAll(() => server.stop());

const NASTY_STATE = "a&b=c+d é日本 %41 ?x#y/z";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const advance = (seconds: number) => server.admin("POST", "/clock", { advance_seconds: seconds });

const CODE_KEYS = [
  "access_token",
  "token_type",
  "refresh_token",
  "expires_in",
  "scope",
  "name",
  "orcid",
];
const CREDENTIALS_KEYS = [
  "access_token",
  "token_type",
  "refresh_token",
  "expires_in",
  "scope",
  "orcid",
];

/** The text of an OAuth error body, to assert ORCID's key order on the raw bytes. */
const errorText = (error: string, description: string) =>
  `{"error":"${error}","error_description":"${description}"}`;
const clientFailed =
  '{"error_description":"Client authentication failed","error":"invalid_client"}';
const MISMATCH =
  "One of the provided parameters is invalid, or, the provided token/code is invalid or expired";

describe("the headless round trip", () => {
  test("login_as, then the code, gives ORCID's token response in ORCID's key order", async () => {
    const authorized = await authorizeAs(server, {
      orcid: ids.alder as string,
      scope: "/authenticate",
      state: NASTY_STATE,
    });
    expect(authorized.state).toBe(NASTY_STATE);

    const reply = await exchangeCode(server, { code: authorized.code });
    expect(reply.status).toBe(200);
    expect(reply.headers.get("content-type")).toBe("application/json;charset=UTF-8");
    expect(reply.headers.get("cache-control")).toBe("no-store");
    expect(reply.headers.get("pragma")).toBe("no-cache");
    expect(Object.keys(reply.json ?? {})).toEqual(CODE_KEYS);
    expect(reply.text).toMatch(
      new RegExp(
        `^\\{"access_token":"${UUID}","token_type":"bearer","refresh_token":"${UUID}",` +
          `"expires_in":631138518,"scope":"/authenticate","name":"A\\. Fennimore",` +
          `"orcid":"${ids.alder}"\\}$`,
      ),
    );
    expect(reply.json?.access_token).not.toBe(reply.json?.refresh_token);
  });

  test("scope is space-separated in the order requested, openid without a slash", async () => {
    const token = await obtainToken(server, {
      orcid: ids.alder as string,
      scope: "openid /read-limited /authenticate",
      client: "member",
    });
    expect(token.scope).toBe("openid /read-limited /authenticate");
    // Duplicates collapse.
    const twice = await obtainToken(server, {
      orcid: ids.alder as string,
      scope: "openid openid /authenticate",
    });
    expect(twice.scope).toBe("openid /authenticate");
  });

  test("every exchange mints different tokens, and an id_token is not added in phase 2", async () => {
    const a = await obtainToken(server, { orcid: ids.alder as string, scope: "openid" });
    const b = await obtainToken(server, { orcid: ids.alder as string, scope: "openid" });
    expect(new Set([a.access_token, a.refresh_token, b.access_token, b.refresh_token]).size).toBe(
      4,
    );
    // Phase 3 (#6) adds id_token for an openid grant; until then the response has none.
    expect(a).not.toHaveProperty("id_token");
  });

  test("name follows the public display name rule", async () => {
    const make = async (name: Record<string, unknown>) => {
      const created = await server.admin<{ orcid: string }>("POST", "/users", { name });
      expect(created.status).toBe(201);
      return (await obtainToken(server, { orcid: created.body.orcid, scope: "/authenticate" }))
        .name;
    };
    // A public credit name wins over the real names.
    expect(
      await obtainToken(server, { orcid: ids.alder as string, scope: "/authenticate" }),
    ).toMatchObject({ name: "A. Fennimore" });
    // No family name: the given name alone, trimmed.
    expect(
      await obtainToken(server, { orcid: ids.sennet as string, scope: "/authenticate" }),
    ).toMatchObject({ name: "Sennet" });
    // Given and family, no credit name.
    expect(await make({ given_names: "Plain", family_name: "Person", visibility: "public" })).toBe(
      "Plain Person",
    );
    // A blank credit name does not count as one.
    expect(
      await make({
        given_names: "Blank",
        family_name: "Credit",
        credit_name: "  ",
        visibility: "public",
      }),
    ).toBe("Blank Credit");
    // A private name is the empty string, credit name or not.
    expect(
      await make({ given_names: "Secret", family_name: "Person", visibility: "private" }),
    ).toBe("");
    expect(
      await make({
        given_names: "Secret",
        family_name: "Credit",
        credit_name: "S. C.",
        visibility: "limited",
      }),
    ).toBe("");
  });

  test("a locked user with a private name, once unlocked, signs in with an empty name", async () => {
    const { body: briar } = await server.admin<Record<string, unknown>>(
      "GET",
      `/users/${ids.briar}`,
    );
    await server.admin("PUT", `/users/${ids.briar}`, { ...briar, locked: false });
    const token = await obtainToken(server, { orcid: ids.briar as string, scope: "/authenticate" });
    expect(token.name).toBe("");
    expect(token.orcid).toBe(ids.briar as string);
  });

  test("a code survives a registered redirect URI with a path and query, which must be repeated", async () => {
    const redirectUri = `${REDIRECT_URI}/sub?next=%2Fhome`;
    const { code } = await authorizeAs(server, {
      orcid: ids.alder as string,
      scope: "/authenticate",
      redirectUri,
    });
    expect((await exchangeCode(server, { code, redirectUri })).status).toBe(200);
  });
});

describe("the token endpoint's request checks", () => {
  test("a JSON body is 415 with ORCID's text and headers", async () => {
    const response = await fetch(`${server.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", ...CLIENTS.public }),
    });
    expect(response.status).toBe(415);
    expect(response.headers.get("content-type")).toBe("text/html;charset=utf-8");
    expect(response.headers.get("accept")).toBe("application/x-www-form-urlencoded");
    expect(await response.text()).toBe("Content-Type 'application/json' is not supported.");
  });

  test("a GET, and a POST with no Content-Type, are 415 with 'null'", async () => {
    const get = await fetch(`${server.baseUrl}/oauth/token?grant_type=client_credentials`);
    expect(get.status).toBe(415);
    expect(await get.text()).toBe("Content-Type 'null' is not supported.");
    const bare = await fetch(`${server.baseUrl}/oauth/token`, { method: "POST" });
    expect(bare.status).toBe(415);
    expect(await bare.text()).toBe("Content-Type 'null' is not supported.");
  });

  test("the Content-Type is escaped in the 415 page", async () => {
    const response = await fetch(`${server.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "text/<b>x</b>" },
      body: "grant_type=client_credentials",
    });
    expect(response.status).toBe(415);
    expect(await response.text()).toBe(
      "Content-Type 'text/&lt;b&gt;x&lt;/b&gt;' is not supported.",
    );
  });

  test("a form Content-Type with a charset, in any case, is accepted", async () => {
    const response = await fetch(`${server.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "Application/X-WWW-Form-Urlencoded; charset=UTF-8" },
      body: new URLSearchParams({ grant_type: "client_credentials", ...CLIENTS.public }),
    });
    expect(response.status).toBe(200);
  });

  test("every JSON answer, success or error, is application/json;charset=UTF-8 as ORCID sends it", async () => {
    const replies = [
      await clientCredentials(server),
      await tokenRequest(server, { grant_type: undefined }),
      await postForm(server, "/oauth/token", { grant_type: "client_credentials" }),
      await tokenRequest(server, { grant_type: "client_credentials", client_secret: "wrong" }),
      await tokenRequest(server, { grant_type: "password" }),
      await clientCredentials(server, { scope: "/authenticate" }),
      await exchangeCode(server, { code: "zzzzzz" }),
      await refreshTokens(server, { refreshToken: "nope" }),
    ];
    expect(replies.map((reply) => reply.status)).toEqual([200, 400, 401, 401, 400, 400, 400, 400]);
    for (const reply of replies) {
      expect(reply.headers.get("content-type")).toBe("application/json;charset=UTF-8");
    }
  });

  test("a missing grant_type is 400, and is checked before the client", async () => {
    const withClient = await tokenRequest(server, { grant_type: undefined });
    expect(withClient.status).toBe(400);
    expect(withClient.text).toBe(errorText("unsupported_grant_type", "grant_type is missing"));
    const noClient = await postForm(server, "/oauth/token", {});
    expect(noClient.status).toBe(400);
    expect(noClient.text).toBe(errorText("unsupported_grant_type", "grant_type is missing"));
    expect((await tokenRequest(server, { grant_type: "" })).text).toBe(noClient.text);
  });

  test("a missing client_id or client_secret is 401 invalid_request naming it", async () => {
    const noId = await postForm(server, "/oauth/token", { grant_type: "client_credentials" });
    expect(noId.status).toBe(401);
    expect(noId.text).toBe(errorText("invalid_request", "client_id is required"));
    const noSecret = await postForm(server, "/oauth/token", {
      grant_type: "client_credentials",
      client_id: CLIENTS.public.client_id,
    });
    expect(noSecret.status).toBe(401);
    expect(noSecret.text).toBe(errorText("invalid_request", "client_secret is required"));
    const emptySecret = await postForm(server, "/oauth/token", {
      grant_type: "client_credentials",
      client_id: CLIENTS.public.client_id,
      client_secret: "",
    });
    expect(emptySecret.text).toBe(noSecret.text);
  });

  test("an unknown client or a wrong secret is 401 with error_description first", async () => {
    for (const grant_type of [
      "client_credentials",
      "authorization_code",
      "refresh_token",
      "password",
    ]) {
      const wrong = await tokenRequest(server, { grant_type, client_secret: "nope" });
      expect(wrong.status).toBe(401);
      expect(wrong.text).toBe(clientFailed);
      const unknown = await tokenRequest(server, { grant_type, client_id: "APP-0000000000000000" });
      expect(unknown.status).toBe(401);
      expect(unknown.text).toBe(clientFailed);
    }
  });

  test("HTTP Basic credentials are accepted, and win over the form", async () => {
    const basic = await postForm(
      server,
      "/oauth/token",
      { grant_type: "client_credentials" },
      {
        authorization: basicAuth("public"),
      },
    );
    expect(basic.status).toBe(200);
    expect(basic.json?.scope).toBe("/read-public");
    // The header decides the client even when the form names another or a wrong secret.
    const overForm = await tokenRequest(
      server,
      { grant_type: "client_credentials", client_secret: "wrong" },
      "public",
      { authorization: basicAuth("member") },
    );
    expect(overForm.status).toBe(200);
    // ...and a bad header is not rescued by good form fields.
    const badHeader = await tokenRequest(server, { grant_type: "client_credentials" }, "public", {
      authorization: `Basic ${btoa(`${CLIENTS.public.client_id}:wrong`)}`,
    });
    expect(badHeader.status).toBe(401);
    expect(badHeader.text).toBe(clientFailed);
  });

  test("a Basic header that is not valid Basic credentials is a bad client", async () => {
    for (const authorization of [
      "Basic",
      "Basic !!!not-base64!!!",
      `Basic ${btoa("no-colon-here")}`,
      `Basic ${btoa(":secret-only")}`,
      "Bearer some-token",
      `Basic ${btoa("a:b")} extra`,
    ]) {
      const reply = await tokenRequest(server, { grant_type: "client_credentials" }, "public", {
        authorization,
      });
      expect(reply.status).toBe(401);
      expect(reply.text).toBe(clientFailed);
    }
    // Unknown id and wrong secret through Basic are the same failure.
    for (const credentials of ["APP-NOPE:orcid-mock-secret", `${CLIENTS.public.client_id}:nope`]) {
      const reply = await postForm(
        server,
        "/oauth/token",
        { grant_type: "client_credentials" },
        {
          authorization: `Basic ${btoa(credentials)}`,
        },
      );
      expect(reply.text).toBe(clientFailed);
    }
  });

  test("a secret that contains a colon survives Basic parsing", async () => {
    await server.admin("PUT", "/clients/APP-COLON", {
      client_secret: "se:cret:with:colons",
      redirect_uris: [REDIRECT_URI],
      member: false,
    });
    const reply = await postForm(
      server,
      "/oauth/token",
      { grant_type: "client_credentials" },
      {
        authorization: `Basic ${btoa("APP-COLON:se:cret:with:colons")}`,
      },
    );
    expect(reply.status).toBe(200);
  });

  test("an unsupported grant with a valid client names the grant", async () => {
    for (const grant of [
      "password",
      "implicit",
      "urn:ietf:params:oauth:grant-type:token-exchange",
    ]) {
      const reply = await tokenRequest(server, { grant_type: grant });
      expect(reply.status).toBe(400);
      expect(reply.text).toBe(
        errorText("unsupported_grant_type", `Unsupported grant type: ${grant}`),
      );
    }
  });
});

describe("authorization_code", () => {
  const signIn = (over: { client?: "public" | "member"; redirectUri?: string } = {}) =>
    authorizeAs(server, { orcid: ids.alder as string, scope: "/authenticate", ...over });

  test("a missing code is 400 invalid_request", async () => {
    const reply = await tokenRequest(server, {
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    });
    expect(reply.status).toBe(400);
    expect(reply.text).toBe(errorText("invalid_request", "code is required"));
  });

  test("an unknown code is invalid_grant naming the code", async () => {
    const reply = await exchangeCode(server, { code: "zzzzzz" });
    expect(reply.status).toBe(400);
    expect(reply.text).toBe(errorText("invalid_grant", "Invalid authorization code: zzzzzz"));
  });

  test("a code works once: reuse is the unknown-code case", async () => {
    const { code } = await signIn();
    expect((await exchangeCode(server, { code })).status).toBe(200);
    const again = await exchangeCode(server, { code });
    expect(again.status).toBe(400);
    expect(again.text).toBe(errorText("invalid_grant", `Invalid authorization code: ${code}`));
  });

  test("concurrent exchanges of one code give exactly one token", async () => {
    const { code } = await signIn();
    const replies = await Promise.all(
      Array.from({ length: 8 }, () => exchangeCode(server, { code })),
    );
    expect(replies.map((reply) => reply.status).sort()).toEqual([
      200, 400, 400, 400, 400, 400, 400, 400,
    ]);
  });

  test("a code expires ten minutes after it was issued, by the server's clock", async () => {
    const fresh = await signIn();
    await advance(599);
    expect((await exchangeCode(server, { code: fresh.code })).status).toBe(200);

    const stale = await signIn();
    await advance(601);
    const reply = await exchangeCode(server, { code: stale.code });
    expect(reply.status).toBe(400);
    expect(reply.text).toBe(
      errorText("invalid_grant", `Invalid authorization code: ${stale.code}`),
    );
    // An expired code is spent: it does not come back.
    expect((await exchangeCode(server, { code: stale.code })).status).toBe(400);
  });

  test("a code issued after the clock moved is measured from the moved clock", async () => {
    await advance(10_000);
    const { code } = await signIn();
    await advance(599);
    expect((await exchangeCode(server, { code })).status).toBe(200);
  });

  test("reset puts the clock back, so a code issued after it has its full ten minutes", async () => {
    await advance(10_000);
    await server.reset();
    const { code } = await signIn();
    await advance(599);
    expect((await exchangeCode(server, { code })).status).toBe(200);
  });

  test("reset forgets codes", async () => {
    const { code } = await signIn();
    await server.reset();
    expect((await exchangeCode(server, { code })).status).toBe(400);
  });

  test("a code belongs to the client it was issued to, and is spent by the attempt", async () => {
    const { code } = await signIn();
    const stolen = await exchangeCode(server, { code, client: "member" });
    expect(stolen.status).toBe(400);
    expect(stolen.text).toBe(errorText("invalid_grant", MISMATCH));
    // The rightful client cannot use it afterwards.
    const owner = await exchangeCode(server, { code });
    expect(owner.text).toBe(errorText("invalid_grant", `Invalid authorization code: ${code}`));
  });

  test("redirect_uri must be present and exactly the one used at authorize", async () => {
    for (const redirectUri of [
      null,
      "",
      `${REDIRECT_URI}/sub`,
      "http://127.0.0.1:3000/callback",
      `${REDIRECT_URI}?x=1`,
    ]) {
      const { code } = await signIn();
      const reply = await exchangeCode(server, { code, redirectUri });
      expect(reply.status).toBe(400);
      expect(reply.text).toBe(errorText("invalid_grant", MISMATCH));
    }
    const { code } = await signIn({ redirectUri: `${REDIRECT_URI}/sub` });
    expect((await exchangeCode(server, { code, redirectUri: REDIRECT_URI })).status).toBe(400);
  });

  test("a code whose user was deleted after authorize is no code at all", async () => {
    const { code } = await signIn();
    await server.admin("DELETE", `/users/${ids.alder}`);
    const reply = await exchangeCode(server, { code });
    expect(reply.status).toBe(400);
    expect(reply.text).toBe(errorText("invalid_grant", `Invalid authorization code: ${code}`));
  });
});

describe("refresh_token", () => {
  const first = () => obtainToken(server, { orcid: ids.alder as string, scope: "/authenticate" });

  test("rotates: new tokens, same scope and user, and the old refresh token stops working", async () => {
    const original = await first();
    const reply = await refreshTokens(server, { refreshToken: original.refresh_token });
    expect(reply.status).toBe(200);
    expect(Object.keys(reply.json ?? {})).toEqual(CODE_KEYS);
    expect(reply.json).toMatchObject({
      token_type: "bearer",
      expires_in: 631138518,
      scope: "/authenticate",
      name: "A. Fennimore",
      orcid: ids.alder,
    });
    expect(reply.json?.access_token).not.toBe(original.access_token);
    expect(reply.json?.refresh_token).not.toBe(original.refresh_token);

    const reused = await refreshTokens(server, { refreshToken: original.refresh_token });
    expect(reused.status).toBe(400);
    expect(reused.text).toBe(
      errorText("invalid_grant", `Invalid refresh token: ${original.refresh_token}`),
    );

    // The new refresh token rotates again, down a chain.
    const next = await refreshTokens(server, { refreshToken: String(reply.json?.refresh_token) });
    expect(next.status).toBe(200);
  });

  test("a refresh response carries no id_token and is not a code-flow response in disguise", async () => {
    const original = await obtainToken(server, { orcid: ids.alder as string, scope: "openid" });
    const reply = await refreshTokens(server, { refreshToken: original.refresh_token });
    expect(Object.keys(reply.json ?? {})).toEqual(CODE_KEYS);
  });

  test("a missing refresh_token is 401 invalid_request", async () => {
    const reply = await tokenRequest(server, { grant_type: "refresh_token" });
    expect(reply.status).toBe(401);
    expect(reply.text).toBe(errorText("invalid_request", "refresh_token is required"));
  });

  test("an unknown refresh token, an access token, and another client's token are invalid_grant", async () => {
    const original = await first();
    for (const [token, client] of [
      ["00000000-0000-4000-8000-000000000000", "public"],
      [original.access_token, "public"],
      [original.refresh_token, "member"],
    ] as const) {
      const reply = await refreshTokens(server, { refreshToken: token, client });
      expect(reply.status).toBe(400);
      expect(reply.text).toBe(errorText("invalid_grant", `Invalid refresh token: ${token}`));
    }
    // None of those spent the real one.
    expect((await refreshTokens(server, { refreshToken: original.refresh_token })).status).toBe(
      200,
    );
  });

  test("a refresh token expires twenty years after issue, by the server's clock", async () => {
    const a = await first();
    await advance(631138518);
    expect((await refreshTokens(server, { refreshToken: a.refresh_token })).status).toBe(200);
    const b = await first();
    await advance(631138520);
    const reply = await refreshTokens(server, { refreshToken: b.refresh_token });
    expect(reply.status).toBe(400);
    expect(reply.text).toBe(
      errorText("invalid_grant", `Invalid refresh token: ${b.refresh_token}`),
    );
  });

  test("revoke_old defaults to true, and only the string true means true", async () => {
    // Legacy refreshAccessToken: absent means true; a present value goes through Boolean.valueOf.
    const kept: Array<string | undefined> = ["false", "FALSE", "0", "", "yes"];
    for (const value of [undefined, "true", "TRUE", ...kept]) {
      const original = await first();
      const rotated = await refreshTokens(server, {
        refreshToken: original.refresh_token,
        extra: { revoke_old: value },
      });
      expect(rotated.status).toBe(200);
      const again = await refreshTokens(server, { refreshToken: original.refresh_token });
      const revoked = value === undefined || value.toLowerCase() === "true";
      expect(again.status).toBe(revoked ? 400 : 200);
    }
  });

  test("scope can narrow to a subset, and the narrowed scope stays narrowed", async () => {
    const original = await obtainToken(server, {
      orcid: ids.alder as string,
      scope: "openid /authenticate /read-limited",
      client: "member",
    });
    const narrowed = await refreshTokens(server, {
      refreshToken: original.refresh_token,
      client: "member",
      extra: { scope: "/authenticate openid" },
    });
    expect(narrowed.status).toBe(200);
    expect(narrowed.json?.scope).toBe("/authenticate openid");
    // The parent now has two scopes, so /read-limited cannot come back.
    const widened = await refreshTokens(server, {
      refreshToken: String(narrowed.json?.refresh_token),
      client: "member",
      extra: { scope: "/read-limited" },
    });
    expect(widened.status).toBe(400);
    expect(widened.text).toBe(errorText("invalid_scope", "Invalid scope: /read-limited"));
    // An empty scope copies the parent's.
    const copied = await refreshTokens(server, {
      refreshToken: String(narrowed.json?.refresh_token),
      client: "member",
      extra: { scope: "" },
    });
    expect(copied.json?.scope).toBe("/authenticate openid");
  });

  test("a scope outside the original, or unknown, is 400 invalid_scope and spends nothing", async () => {
    const original = await first();
    for (const [scope, offending] of [
      ["/read-limited", "/read-limited"],
      ["/authenticate openid", "openid"],
      ["/activities/update", "/activities/update"],
      ["/read-limited /activities/update", "/read-limited /activities/update"],
    ] as const) {
      const reply = await refreshTokens(server, {
        refreshToken: original.refresh_token,
        extra: { scope },
      });
      expect(reply.status).toBe(400);
      expect(reply.text).toBe(errorText("invalid_scope", `Invalid scope: ${offending}`));
    }
    expect((await refreshTokens(server, { refreshToken: original.refresh_token })).status).toBe(
      200,
    );
  });

  test("a client-credentials token refreshes into another client-credentials token", async () => {
    const credentials = await clientCredentials(server);
    const reply = await refreshTokens(server, {
      refreshToken: String(credentials.json?.refresh_token),
    });
    expect(reply.status).toBe(200);
    expect(Object.keys(reply.json ?? {})).toEqual(CREDENTIALS_KEYS);
    expect(reply.json?.orcid).toBeNull();
  });

  test("a refresh token whose user was deleted cannot be used, and is not spent", async () => {
    const original = await first();
    await server.admin("DELETE", `/users/${ids.alder}`);
    const reply = await refreshTokens(server, { refreshToken: original.refresh_token });
    expect(reply.status).toBe(400);
    expect(reply.text).toBe(
      errorText("invalid_grant", `Invalid refresh token: ${original.refresh_token}`),
    );
  });

  test("concurrent refreshes of one token give exactly one new token", async () => {
    const original = await first();
    const replies = await Promise.all(
      Array.from({ length: 6 }, () =>
        refreshTokens(server, { refreshToken: original.refresh_token }),
      ),
    );
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 400, 400, 400, 400, 400]);
  });
});

describe("client_credentials", () => {
  test("gives a /read-public token with orcid null and no name, in ORCID's key order", async () => {
    for (const client of ["public", "member"] as const) {
      for (const scope of [undefined, "/read-public", "", "  /read-public  "]) {
        const reply = await clientCredentials(server, { client, scope });
        expect(reply.status).toBe(200);
        expect(Object.keys(reply.json ?? {})).toEqual(CREDENTIALS_KEYS);
        expect(reply.json).toMatchObject({
          token_type: "bearer",
          expires_in: 631138518,
          scope: "/read-public",
          orcid: null,
        });
        expect(reply.text).toMatch(
          new RegExp(
            `^\\{"access_token":"${UUID}","token_type":"bearer","refresh_token":"${UUID}",` +
              `"expires_in":631138518,"scope":"/read-public","orcid":null\\}$`,
          ),
        );
        expect(reply.text).not.toContain('"name"');
      }
    }
  });

  test("any other scope is 400 invalid_scope naming what is wrong", async () => {
    for (const [scope, offending] of [
      ["/authenticate", "/authenticate"],
      ["openid", "openid"],
      ["/read-limited", "/read-limited"],
      ["/read-public /authenticate", "/authenticate"],
      ["/activities/update", "/activities/update"],
      ["/webhook", "/webhook"],
    ] as const) {
      const reply = await clientCredentials(server, { scope });
      expect(reply.status).toBe(400);
      expect(reply.text).toBe(errorText("invalid_scope", `Invalid scope: ${offending}`));
    }
  });

  test("the secret is still checked", async () => {
    const reply = await tokenRequest(server, {
      grant_type: "client_credentials",
      client_secret: "wrong",
    });
    expect(reply.text).toBe(clientFailed);
  });
});
