import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { startTestServer, type TestServer } from "./harness";
import {
  authorizeAs,
  authorizeUrl,
  CLIENTS,
  parseForms,
  REDIRECT_URI,
  sessionCookie,
  submitForm,
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

const CLIENT = CLIENTS.public;
const MEMBER = CLIENTS.member;
// The characters most likely to be mangled by an encoder: & = + space, a percent sequence, a
// query and fragment delimiter, and non-ASCII text.
const NASTY_STATE = "a&b=c+d é日本 %41 ?x#y/z";

/** A GET /oauth/authorize that is valid unless `over` changes it; an undefined value drops it. */
function authorize(over: Record<string, string | undefined> = {}, init: RequestInit = {}) {
  return fetch(
    authorizeUrl(server.baseUrl, {
      client_id: CLIENT.client_id,
      response_type: "code",
      scope: "/authenticate",
      redirect_uri: REDIRECT_URI,
      state: "xyz",
      ...over,
    }),
    { redirect: "manual", ...init },
  );
}

async function expectJsonError(
  response: Response,
  status: number,
  raw: string,
  contentType = "application/json;charset=ISO-8859-1",
) {
  expect(response.status).toBe(status);
  expect(response.headers.get("location")).toBeNull();
  // The authorization server's JSON errors were observed with ISO-8859-1; orcid-mock's own
  // login_as errors, which echo what the caller sent, are plain application/json.
  expect(response.headers.get("content-type")).toBe(contentType);
  // The raw text carries ORCID's key order.
  expect(await response.text()).toBe(raw);
  expect(sessionCookie(response)).toBeNull();
}

/** The Location of an error redirect, which carries no code, no state, and no cookie. */
function expectErrorFragment(response: Response, redirectUri: string, fragment: string) {
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(`${redirectUri}#${fragment}`);
  expect(sessionCookie(response)).toBeNull();
}

describe("the headless round trip with login_as", () => {
  test("redirects with a six-character code and the exact state, and sets the session cookie", async () => {
    const result = await authorizeAs(server, {
      orcid: ids.alder as string,
      scope: "/authenticate",
      state: NASTY_STATE,
    });
    expect(result.response.status).toBe(302);
    expect(result.code).toMatch(/^[0-9a-zA-Z]{6}$/);
    expect(result.state).toBe(NASTY_STATE);
    // Encoded once, not twice: the state is the last parameter, as one encodeURIComponent.
    expect(result.location).toBe(
      `${REDIRECT_URI}?code=${result.code}&state=${encodeURIComponent(NASTY_STATE)}`,
    );
    // The literal "%41" in the state is encoded once (%2541), not twice.
    expect(result.location).toContain("%2541");
    expect(result.location).not.toContain("%252541");

    // A session cookie with the flags the brief fixes, and nothing else (no Max-Age, no Domain).
    const setCookie = result.response.headers.getSetCookie();
    expect(setCookie).toHaveLength(1);
    expect(setCookie[0]).toMatch(
      /^orcid_mock_session=[0-9a-f-]{36}; Path=\/; HttpOnly; SameSite=Lax$/,
    );
    expect(result.cookie).toBe((setCookie[0] ?? "").split(";")[0] ?? null);
  });

  test("leaves state out when the request had none, and keeps an empty one", async () => {
    const without = await authorizeAs(server, { orcid: ids.alder as string, scope: "openid" });
    expect(without.state).toBeNull();
    expect(without.location).toBe(`${REDIRECT_URI}?code=${without.code}`);

    const response = await authorize({ state: "", login_as: ids.alder });
    expect(response.headers.get("location")).toMatch(/\?code=[0-9a-zA-Z]{6}&state=$/);
  });

  test("each call issues a different code and a different session", async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        authorizeAs(server, { orcid: ids.alder as string, scope: "/authenticate" }),
      ),
    );
    expect(new Set(results.map((result) => result.code)).size).toBe(25);
    expect(new Set(results.map((result) => result.cookie)).size).toBe(25);
  });

  test("codes use the whole [0-9a-zA-Z] alphabet and nothing else", async () => {
    const seen = new Set<string>();
    for (let n = 0; n < 150; n++) {
      const { code } = await authorizeAs(server, { orcid: ids.alder as string, scope: "openid" });
      expect(code).toMatch(/^[0-9a-zA-Z]{6}$/);
      for (const char of code) seen.add(char);
    }
    // 900 draws from 62 characters: each class is seen with overwhelming probability.
    expect([...seen].some((char) => /[0-9]/.test(char))).toBe(true);
    expect([...seen].some((char) => /[a-z]/.test(char))).toBe(true);
    expect([...seen].some((char) => /[A-Z]/.test(char))).toBe(true);
  });

  test("a redirect URI under the registered path is allowed, and its query is kept", async () => {
    const sub = await authorizeAs(server, {
      orcid: ids.alder as string,
      scope: "/authenticate",
      redirectUri: `${REDIRECT_URI}/sub`,
      state: "s",
    });
    expect(sub.location).toBe(`${REDIRECT_URI}/sub?code=${sub.code}&state=s`);

    const withQuery = await authorizeAs(server, {
      orcid: ids.alder as string,
      scope: "/authenticate",
      redirectUri: `${REDIRECT_URI}?next=%2Fhome&x=1`,
      state: "s",
    });
    expect(withQuery.location).toBe(
      `${REDIRECT_URI}?next=%2Fhome&x=1&code=${withQuery.code}&state=s`,
    );

    const withFragment = await authorizeAs(server, {
      orcid: ids.alder as string,
      scope: "/authenticate",
      redirectUri: `${REDIRECT_URI}?a=1#frag`,
    });
    expect(withFragment.location).toBe(`${REDIRECT_URI}?a=1&code=${withFragment.code}#frag`);
  });

  test("a member client may ask for /read-limited, with + or %20 between scopes", async () => {
    const plus = await authorize({
      client_id: MEMBER.client_id,
      login_as: ids.alder,
      scope: "openid /read-limited",
    });
    expect(plus.status).toBe(302);
    expect(plus.headers.get("location")).toContain("?code=");

    const url =
      `${server.baseUrl}/oauth/authorize?client_id=${MEMBER.client_id}&response_type=code` +
      `&scope=openid%20/read-limited%20/authenticate&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&login_as=${ids.alder}`;
    const percent = await fetch(url, { redirect: "manual" });
    expect(percent.status).toBe(302);
    expect(percent.headers.get("location")).toContain("?code=");
    const plusUrl = await fetch(url.replace(/%20/g, "+"), { redirect: "manual" });
    expect(plusUrl.status).toBe(302);
    expect(plusUrl.headers.get("location")).toContain("?code=");
  });

  test("a user without a family name or with a private name can sign in", async () => {
    for (const id of [ids.sennet as string]) {
      const result = await authorizeAs(server, { orcid: id, scope: "/authenticate" });
      expect(result.code).toMatch(/^[0-9a-zA-Z]{6}$/);
    }
  });

  test("an unknown login_as iD is a 400 and no redirect", async () => {
    const response = await authorize({ login_as: "0000-0002-1825-0097" });
    await expectJsonError(
      response,
      400,
      '{"error":"invalid_request","error_description":"Unknown login_as iD: 0000-0002-1825-0097"}',
      "application/json",
    );
  });

  test("a locked user and a deactivated user are refused with a 400 that says so", async () => {
    const locked = await authorize({ login_as: ids.briar });
    expect(locked.status).toBe(400);
    expect(locked.headers.get("location")).toBeNull();
    expect(await locked.json()).toEqual({
      error: "invalid_request",
      error_description: `login_as iD ${ids.briar} is locked and cannot sign in`,
    });

    const created = await server.admin<{ orcid: string }>("POST", "/users", {
      name: { given_names: "Gone", visibility: "public" },
      deactivated: true,
    });
    const deactivated = await authorize({ login_as: created.body.orcid });
    expect(deactivated.status).toBe(400);
    expect(await deactivated.json()).toEqual({
      error: "invalid_request",
      error_description: `login_as iD ${created.body.orcid} is deactivated and cannot sign in`,
    });
    expect(sessionCookie(deactivated)).toBeNull();
  });
});

describe("the up-front checks never redirect", () => {
  test("a missing client_id is a 400 with error_description first", async () => {
    await expectJsonError(
      await authorize({ client_id: undefined }),
      400,
      '{"error_description":"Missing parameter: client_id is missing","error":"invalid_request"}',
    );
    await expectJsonError(
      await authorize({ client_id: "" }),
      400,
      '{"error_description":"Missing parameter: client_id is missing","error":"invalid_request"}',
    );
  });

  test("an unknown client_id is a 400 with error_description first, however good the rest is", async () => {
    await expectJsonError(
      await authorize({ client_id: "APP-0000000000000000", login_as: ids.alder }),
      400,
      '{"error_description":"Invalid parameter: client_id","error":"invalid_request"}',
    );
  });

  const MISMATCH =
    '{"error":"invalid_grant","error_description":"Redirect URI doesn\'t match your registered redirect URIs."}';

  test("a missing redirect_uri is a 400 with the legacy text", async () => {
    await expectJsonError(await authorize({ redirect_uri: undefined }), 400, MISMATCH);
    await expectJsonError(await authorize({ redirect_uri: "" }), 400, MISMATCH);
  });

  test("a redirect_uri that is not under a registered one is refused, never followed", async () => {
    for (const uri of [
      "http://localhost:3000/call",
      "http://localhost:3000/",
      "http://localhost:3001/callback",
      "https://localhost:3000/callback",
      "http://LOCALHOST:3000/callback",
      "http://localhost:3000.evil.test/callback",
      "http://localhost:3000/callback/../other",
      "http://evil.example.test/callback",
      "http://localhost:3000/callback\r\nSet-Cookie: a=b",
      "javascript:alert(1)",
      "/callback",
      "not a uri",
    ]) {
      await expectJsonError(
        await authorize({ redirect_uri: uri, login_as: ids.alder }),
        400,
        MISMATCH,
      );
    }
  });

  test("one client's redirect URIs do not open another client's", async () => {
    await server.admin("PUT", "/clients/APP-OTHER", {
      client_secret: "other-secret",
      redirect_uris: ["https://other.example.test/cb"],
      member: false,
    });
    await expectJsonError(
      await authorize({ redirect_uri: "https://other.example.test/cb" }),
      400,
      MISMATCH,
    );
    const ok = await authorize({
      client_id: "APP-OTHER",
      redirect_uri: "https://other.example.test/cb/x",
      login_as: ids.alder,
    });
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toMatch(/^https:\/\/other\.example\.test\/cb\/x\?code=/);
  });

  test("the checks run in order: client, then redirect_uri, then response_type and scope", async () => {
    // Unknown client and a bad redirect_uri: the client error wins.
    await expectJsonError(
      await authorize({ client_id: "APP-NOPE", redirect_uri: "http://evil.test/" }),
      400,
      '{"error_description":"Invalid parameter: client_id","error":"invalid_request"}',
    );
    // A bad redirect_uri with a bad response_type and scope: a 400, never a redirect to it.
    await expectJsonError(
      await authorize({
        redirect_uri: "http://evil.test/",
        response_type: "token",
        scope: undefined,
      }),
      400,
      MISMATCH,
    );
  });
});

describe("a missing response_type is a 400, reported before a missing client", () => {
  const MISSING_TYPE =
    '{"error_description":"Missing parameter: response_type","error":"invalid_request"}';

  test("with no query at all, response_type is the parameter named", async () => {
    await expectJsonError(await fetch(`${server.baseUrl}/oauth/authorize`), 400, MISSING_TYPE);
  });

  test("an absent or empty response_type is a 400 even when the rest is good", async () => {
    for (const response_type of ["", undefined]) {
      await expectJsonError(
        await authorize({ response_type, login_as: ids.alder }),
        400,
        MISSING_TYPE,
      );
    }
  });

  test("and it comes before a missing or unknown client", async () => {
    await expectJsonError(
      await authorize({ response_type: undefined, client_id: undefined }),
      400,
      MISSING_TYPE,
    );
    await expectJsonError(
      await authorize({ response_type: undefined, client_id: "APP-NOPE" }),
      400,
      MISSING_TYPE,
    );
  });
});

describe("response_type and scope errors go back to the client as a fragment", () => {
  test("a response_type other than code is unsupported_response_type", async () => {
    for (const response_type of ["token", "id_token", "CODE", "code token"]) {
      expectErrorFragment(
        await authorize({ response_type, login_as: ids.alder }),
        REDIRECT_URI,
        "error=unsupported_response_type",
      );
    }
  });

  test("a missing, blank, unknown, or forbidden scope is invalid_scope", async () => {
    for (const scope of [
      undefined,
      "",
      "   ",
      "/activities/update",
      "/authenticate /activities/update",
      "Openid",
      "/read-public",
      "openid /read-public",
      // The public client may not ask for /read-limited.
      "/read-limited",
      "openid /read-limited",
    ]) {
      expectErrorFragment(
        await authorize({ scope, login_as: ids.alder }),
        REDIRECT_URI,
        "error=invalid_scope",
      );
    }
    // The member client may, but /read-public stays a client-credentials scope.
    expectErrorFragment(
      await authorize({ client_id: MEMBER.client_id, scope: "/read-public", login_as: ids.alder }),
      REDIRECT_URI,
      "error=invalid_scope",
    );
  });

  test("response_type is checked before scope", async () => {
    expectErrorFragment(
      await authorize({ response_type: "token", scope: "/nope" }),
      REDIRECT_URI,
      "error=unsupported_response_type",
    );
  });

  test("the error keeps the redirect URI's own query and replaces its fragment, and drops state", async () => {
    expectErrorFragment(
      await authorize({
        redirect_uri: `${REDIRECT_URI}/sub?x=1#old`,
        scope: "nope",
        state: "keep-me?",
      }),
      `${REDIRECT_URI}/sub?x=1`,
      "error=invalid_scope",
    );
  });
});

describe("the consent page", () => {
  test("lists every user, the client, and the requested scopes, and carries the request", async () => {
    const response = await authorize({
      scope: "openid /authenticate",
      state: NASTY_STATE,
      nonce: "n-0S6_WzA2Mj",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(sessionCookie(response)).toBeNull();
    const html = await response.text();

    expect(html).toContain("<title>orcid-mock sign in</title>");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<strong>orcid-mock public client</strong>");
    expect(html).toContain("<code>openid</code>");
    expect(html).toContain("<code>/authenticate</code>");
    // No script, no external asset.
    expect(html).not.toMatch(/<script|<link|<img|<iframe|\bsrc=|@import|url\(/i);

    const forms = parseForms(html);
    // Three starter users and the Deny form.
    expect(forms).toHaveLength(4);
    const users = forms.slice(0, 3);
    expect(users.map((form) => form.button)).toEqual([
      `Alder Fennimore (${ids.alder})`,
      `Sennet (${ids.sennet})`,
      `Briar Ashgrove (${ids.briar})`,
    ]);
    for (const form of forms) {
      expect(form.method).toBe("post");
      expect(form.action).toBe(`${server.publicBaseUrl}/oauth/authorize`);
      // Every original parameter is carried, the iD aside.
      expect(form.fields.filter(([name]) => name !== "orcid" && name !== "action")).toEqual([
        ["client_id", CLIENT.client_id],
        ["response_type", "code"],
        ["scope", "openid /authenticate"],
        ["redirect_uri", REDIRECT_URI],
        ["state", NASTY_STATE],
        ["nonce", "n-0S6_WzA2Mj"],
      ]);
    }
    expect(users.map((form) => form.fields.find(([name]) => name === "orcid")?.[1])).toEqual([
      ids.alder,
      ids.sennet,
      ids.briar,
    ]);
    expect(forms[3]?.button).toBe("Deny");
    expect(forms[3]?.fields.find(([name]) => name === "action")).toEqual(["action", "deny"]);
    // The locked user is listed, marked as refused.
    expect(html).toContain("locked: sign-in is refused");
  });

  test("a page with no users still offers Deny", async () => {
    for (const id of Object.values(ids)) await server.admin("DELETE", `/users/${id}`);
    const html = await (await authorize()).text();
    expect(html).toContain("No users are defined");
    expect(parseForms(html).map((form) => form.button)).toEqual(["Deny"]);
  });

  test("escapes every interpolated value, so a hostile user, client, or parameter is inert", async () => {
    const created = await server.admin<{ orcid: string }>("POST", "/users", {
      name: {
        given_names: "<script>alert(1)</script>",
        family_name: '"><img src=x onerror=alert(2)>',
        visibility: "public",
      },
    });
    await server.admin("PUT", "/clients/APP-XSS", {
      client_secret: "s",
      name: "<b onmouseover=alert(3)>Evil & Co</b>",
      redirect_uris: [REDIRECT_URI],
      member: false,
    });
    const url = new URL(
      authorizeUrl(server.baseUrl, {
        client_id: "APP-XSS",
        response_type: "code",
        scope: "/authenticate",
        redirect_uri: `${REDIRECT_URI}?q="><script>alert(4)</script>`,
        state: "'><script>alert(5)</script>",
      }),
    );
    url.searchParams.set('x"><script>alert(6)</script>', "1");
    const html = await (await fetch(url)).text();

    // Nothing hostile survives as markup.
    expect(html).not.toMatch(/<script>alert|<img src=x|<b onmouseover/);
    expect(html).not.toContain('"><script');
    expect(html).not.toContain("'><script");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;b onmouseover=alert(3)&gt;Evil &amp; Co&lt;/b&gt;");

    // And the escaped values read back, through an HTML parser's rules, as what was sent.
    const forms = parseForms(html);
    const hostile = forms.find((form) =>
      form.fields.some(([, value]) => value === created.body.orcid),
    );
    expect(hostile?.button).toBe(
      `<script>alert(1)</script> "><img src=x onerror=alert(2)> (${created.body.orcid})`,
    );
    expect(forms[0]?.fields).toContainEqual(["state", "'><script>alert(5)</script>"]);
    expect(forms[0]?.fields).toContainEqual(['x"><script>alert(6)</script>', "1"]);
  });

  test("a hidden-field name of orcid or action in the request cannot steer the form", async () => {
    const html = await (await authorize({ orcid: "0000-0002-1825-0097", action: "deny" })).text();
    for (const form of parseForms(html).slice(0, 3)) {
      expect(form.fields.filter(([name]) => name === "orcid")).toHaveLength(1);
      expect(form.fields.some(([name]) => name === "action")).toBe(false);
    }
  });

  test("the form action comes from PUBLIC_BASE_URL, path prefix included, never from Host", async () => {
    const proxied = await startTestServer({ publicBaseUrl: "https://orcid.example.test/mock" });
    try {
      const response = await fetch(
        authorizeUrl(proxied.baseUrl, {
          client_id: CLIENT.client_id,
          response_type: "code",
          scope: "/authenticate",
          redirect_uri: REDIRECT_URI,
        }),
        { headers: { host: "attacker.example.test" } },
      );
      expect(response.status).toBe(200);
      const actions = parseForms(await response.text()).map((form) => form.action);
      expect(new Set(actions)).toEqual(
        new Set(["https://orcid.example.test/mock/oauth/authorize"]),
      );
    } finally {
      await proxied.stop();
    }
  });

  test("choosing a user issues a code, sets the session, and returns the exact state", async () => {
    const html = await (await authorize({ state: NASTY_STATE })).text();
    const alder = parseForms(html)[0];
    if (!alder) throw new Error("no form");
    const response = await submitForm(alder);
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    const url = new URL(location);
    expect(`${url.origin}${url.pathname}`).toBe(REDIRECT_URI);
    expect(url.searchParams.get("code")).toMatch(/^[0-9a-zA-Z]{6}$/);
    expect(url.searchParams.get("state")).toBe(NASTY_STATE);
    expect(location).toContain(`state=${encodeURIComponent(NASTY_STATE)}`);
    expect(sessionCookie(response)).toMatch(/^orcid_mock_session=[0-9a-f-]{36}$/);
  });

  test("Deny redirects with access_denied, the description, and the state", async () => {
    const html = await (await authorize({ state: NASTY_STATE })).text();
    const deny = parseForms(html)[3];
    if (!deny) throw new Error("no deny form");
    const response = await submitForm(deny);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${REDIRECT_URI}?error=access_denied&error_description=User%20denied%20access&state=${encodeURIComponent(NASTY_STATE)}`,
    );
    expect(sessionCookie(response)).toBeNull();
  });

  test("Deny appends to a redirect URI that has a query, and omits an absent state", async () => {
    const html = await (
      await authorize({ redirect_uri: `${REDIRECT_URI}?x=1`, state: undefined })
    ).text();
    const deny = parseForms(html)[3];
    if (!deny) throw new Error("no deny form");
    const response = await submitForm(deny);
    expect(response.headers.get("location")).toBe(
      `${REDIRECT_URI}?x=1&error=access_denied&error_description=User%20denied%20access`,
    );
  });

  test("the submission re-runs the up-front checks on what the form carries", async () => {
    const html = await (await authorize()).text();
    const alder = parseForms(html)[0];
    if (!alder) throw new Error("no form");
    const tamper = (name: string, value: string) =>
      submitForm({
        ...alder,
        fields: alder.fields.map(([n, v]) => (n === name ? [n, value] : [n, v])),
      });

    const client = await tamper("client_id", "APP-NOPE");
    expect(client.status).toBe(400);
    expect(await client.text()).toBe(
      '{"error_description":"Invalid parameter: client_id","error":"invalid_request"}',
    );
    const redirect = await tamper("redirect_uri", "http://evil.example.test/callback");
    expect(redirect.status).toBe(400);
    expect(redirect.headers.get("location")).toBeNull();
    expect(await redirect.json()).toMatchObject({ error: "invalid_grant" });
    const scope = await tamper("scope", "/read-limited");
    expectErrorFragment(scope, REDIRECT_URI, "error=invalid_scope");
    const type = await tamper("response_type", "token");
    expectErrorFragment(type, REDIRECT_URI, "error=unsupported_response_type");
  });

  test("an unknown, missing, locked, or deactivated user in the submission is a 400", async () => {
    const html = await (await authorize()).text();
    const alder = parseForms(html)[0];
    if (!alder) throw new Error("no form");
    const withUser = (orcid: string | null) =>
      submitForm({
        ...alder,
        fields: [
          ...alder.fields.filter(([name]) => name !== "orcid"),
          ...(orcid === null ? [] : [["orcid", orcid] as [string, string]]),
        ],
      });

    const unknown = await withUser("0000-0002-1825-0097");
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toBe(
      '{"error":"invalid_request","error_description":"Unknown orcid iD: 0000-0002-1825-0097"}',
    );
    const missing = await withUser(null);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: "invalid_request",
      error_description: "Missing parameter: orcid",
    });
    const locked = await withUser(ids.briar as string);
    expect(locked.status).toBe(400);
    expect(await locked.json()).toEqual({
      error: "invalid_request",
      error_description: `orcid iD ${ids.briar} is locked and cannot sign in`,
    });
    expect(sessionCookie(locked)).toBeNull();
  });

  test("the submission must be form-encoded", async () => {
    const json = await fetch(`${server.baseUrl}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT.client_id }),
    });
    expect(json.status).toBe(415);
    expect(json.headers.get("content-type")).toBe("text/html;charset=utf-8");
    expect(await json.text()).toBe("Content-Type 'application/json' is not supported.");
    const bare = await fetch(`${server.baseUrl}/oauth/authorize`, { method: "POST" });
    expect(bare.status).toBe(415);
    expect(await bare.text()).toBe("Content-Type 'null' is not supported.");
  });

  test("other methods on /oauth/authorize are unrouted", async () => {
    const response = await fetch(`${server.baseUrl}/oauth/authorize`, { method: "PUT" });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });
});

describe("prompt", () => {
  const OPENID = "openid /authenticate";

  /** Signs Alder in with login_as and returns the session cookie the response set. */
  async function signedIn(orcid = ids.alder as string): Promise<string> {
    const { cookie } = await authorizeAs(server, { orcid, scope: OPENID });
    if (cookie === null) throw new Error("no session cookie");
    return cookie;
  }

  const none = (cookie?: string, over: Record<string, string | undefined> = {}) =>
    authorize(
      { scope: OPENID, prompt: "none", state: "silent", ...over },
      cookie ? { headers: { cookie } } : {},
    );

  test("prompt=none with a session issues a code silently for the session's user", async () => {
    const cookie = await signedIn();
    const response = await none(cookie);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(
      new RegExp(`^${REDIRECT_URI}\\?code=[0-9a-zA-Z]{6}&state=silent$`),
    );
    // The existing session keeps going: no new cookie.
    expect(sessionCookie(response)).toBeNull();
    // And the cookie still works a second time.
    expect((await none(cookie)).headers.get("location")).toContain("?code=");
  });

  test("prompt=none without a session redirects with the login_required fragment", async () => {
    expectErrorFragmentLoginRequired(await none(), REDIRECT_URI);
    // State is not carried, as in the current front end.
    expectErrorFragmentLoginRequired(await none(undefined, { state: "ignored" }), REDIRECT_URI);
  });

  test("prompt=none keeps the redirect URI's query and replaces its fragment", async () => {
    expectErrorFragmentLoginRequired(
      await none(undefined, { redirect_uri: `${REDIRECT_URI}/sub?x=1#old` }),
      `${REDIRECT_URI}/sub?x=1`,
    );
  });

  test("an unknown, expired, deleted, locked, or deactivated session is no session", async () => {
    expectErrorFragmentLoginRequired(
      await none("orcid_mock_session=00000000-0000-4000-8000-000000000000"),
      REDIRECT_URI,
    );
    expectErrorFragmentLoginRequired(await none("orcid_mock_session="), REDIRECT_URI);
    expectErrorFragmentLoginRequired(await none("other_cookie=1"), REDIRECT_URI);

    // Sessions last 24 hours of server time.
    const fresh = await signedIn();
    await server.admin("POST", "/clock", { advance_seconds: 24 * 3600 - 60 });
    expect((await none(fresh)).headers.get("location")).toContain("?code=");
    await server.admin("POST", "/clock", { advance_seconds: 120 });
    expectErrorFragmentLoginRequired(await none(fresh), REDIRECT_URI);
    await server.reset();

    const doomed = await signedIn();
    await server.admin("DELETE", `/users/${ids.alder}`);
    expectErrorFragmentLoginRequired(await none(doomed), REDIRECT_URI);
    await server.reset();

    for (const flag of ["locked", "deactivated"]) {
      const cookie = await signedIn();
      const { body: user } = await server.admin<Record<string, unknown>>(
        "GET",
        `/users/${ids.alder}`,
      );
      await server.admin("PUT", `/users/${ids.alder}`, { ...user, [flag]: true });
      expectErrorFragmentLoginRequired(await none(cookie), REDIRECT_URI);
      await server.reset();
    }
  });

  test("a new sign-in replaces the session the request carried", async () => {
    const first = await signedIn();
    const { cookie: second } = await authorizeAs(server, {
      orcid: ids.sennet as string,
      scope: OPENID,
      cookie: first,
    });
    expect(second).not.toBe(first);
    expectErrorFragmentLoginRequired(await none(first), REDIRECT_URI);
    expect((await none(second ?? "")).headers.get("location")).toContain("?code=");
  });

  test("prompt=none is honored only with the openid scope", async () => {
    const cookie = await signedIn();
    // Without openid the request is an ordinary one: the page, with or without a session.
    for (const headers of [undefined, { cookie }]) {
      const response = await authorize(
        { scope: "/authenticate", prompt: "none" },
        headers ? { headers } : {},
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    }
  });

  test("prompt=none still gets the up-front checks first", async () => {
    expectErrorFragment(
      await none(undefined, { scope: "openid /read-public" }),
      REDIRECT_URI,
      "error=invalid_scope",
    );
    expect((await none(undefined, { redirect_uri: "http://evil.test/" })).status).toBe(400);
  });

  test("login_as does not override prompt=none", async () => {
    expectErrorFragmentLoginRequired(await none(undefined, { login_as: ids.alder }), REDIRECT_URI);
  });

  test("prompt=login with openid ignores the session and shows the page", async () => {
    const cookie = await signedIn();
    const response = await authorize({ scope: OPENID, prompt: "login" }, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain("<title>orcid-mock sign in</title>");
  });

  test("prompt=login with login_as still signs in, as a forced re-login", async () => {
    const cookie = await signedIn();
    const again = await authorizeAs(server, {
      orcid: ids.sennet as string,
      scope: OPENID,
      prompt: "login",
      cookie,
    });
    expect(again.code).toMatch(/^[0-9a-zA-Z]{6}$/);
    expect(again.cookie).not.toBe(cookie);
  });

  test("an unknown prompt value is ignored", async () => {
    const cookie = await signedIn();
    const response = await authorize({ scope: OPENID, prompt: "consent" }, { headers: { cookie } });
    expect(response.status).toBe(200);
  });
});

function expectErrorFragmentLoginRequired(response: Response, redirectUri: string) {
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(`${redirectUri}#login_required`);
  expect(sessionCookie(response)).toBeNull();
}
