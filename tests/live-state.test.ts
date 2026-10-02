// What a change through the admin API does to state that is already live: a client that loses its
// membership, a user that is locked or deactivated, a user that is deleted or replaced (ADR 0009).
// Every token comes from the real token endpoint and every check is a real request.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { IDS, RECORD_USERS_FILE } from "./fixtures/record";
import { startTestServer, type TestServer } from "./harness";
import {
  authorizeAs,
  authorizeUrl,
  CLIENTS,
  exchangeCode,
  obtainToken,
  REDIRECT_URI,
  refreshTokens,
} from "./helpers/oauth";
import { getRecord, type RecordReply } from "./helpers/record";

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

/** Replaces a user with itself plus `patch`, through the admin API (an upsert, so a PUT). */
async function patchUser(orcid: string, patch: Record<string, unknown>): Promise<void> {
  const current = await server.admin<Record<string, unknown>>("GET", `/users/${orcid}`);
  const put = await server.admin("PUT", `/users/${orcid}`, { ...current.body, ...patch });
  expect(put.status).toBe(200);
}

const userinfo = (accessToken: string) =>
  fetch(`${server.baseUrl}/oauth/userinfo`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

/** Sets whether the starter's member client is a member, through the admin API. */
async function setMember(member: boolean): Promise<void> {
  const id = CLIENTS.member.client_id;
  const current = await server.admin<Record<string, unknown>>("GET", `/clients/${id}`);
  const put = await server.admin("PUT", `/clients/${id}`, { ...current.body, member });
  expect(put.status).toBe(200);
}

describe("a client that loses its membership", () => {
  test("its existing /read-limited token reads the public view, and reads limited again if the membership returns", async () => {
    const token = await obtainToken(server, {
      orcid: IDS.rich,
      scope: "/read-limited",
      client: "member",
    });
    const read = () => getRecord(server, RICH_EMAIL, { token: token.access_token });
    expect(emailsOf(await read())).toEqual(WITH_LIMITED);

    await setMember(false);
    const demoted = await read();
    // The token itself is still good: this is the public view, not a 401.
    expect(demoted.status).toBe(200);
    expect(emailsOf(demoted)).toEqual(PUBLIC_ONLY);

    await setMember(true);
    expect(emailsOf(await read())).toEqual(WITH_LIMITED);
  });

  test("a client demoted between authorize and the code exchange gets 400 invalid_scope and no token", async () => {
    const limited = await authorizeAs(server, {
      orcid: IDS.rich,
      scope: "openid /read-limited",
      client: "member",
    });
    const narrow = await authorizeAs(server, {
      orcid: IDS.rich,
      scope: "openid",
      client: "member",
    });
    await setMember(false);

    const refused = await exchangeCode(server, { code: limited.code, client: "member" });
    expect(refused.status).toBe(400);
    expect(refused.json).toEqual({
      error: "invalid_scope",
      error_description: "Invalid scope: /read-limited",
    });
    // The code was consumed, as for any refused exchange: promoting the client does not revive it.
    await setMember(true);
    const again = await exchangeCode(server, { code: limited.code, client: "member" });
    expect(again.json?.error).toBe("invalid_grant");

    // A code for a narrower scope exchanges whatever the client's membership.
    await setMember(false);
    const ok = await exchangeCode(server, { code: narrow.code, client: "member" });
    expect(ok.status).toBe(200);
    expect(ok.json?.scope).toBe("openid");
  });

  test("a refresh that would keep /read-limited is 400 invalid_scope, and burns nothing", async () => {
    const token = await obtainToken(server, {
      orcid: IDS.rich,
      scope: "openid /read-limited",
      client: "member",
    });
    await setMember(false);

    for (const extra of [{}, { scope: "openid /read-limited" }, { scope: "/read-limited" }]) {
      const refused = await refreshTokens(server, {
        refreshToken: token.refresh_token,
        client: "member",
        extra,
      });
      expect(refused.status).toBe(400);
      expect(refused.json).toEqual({
        error: "invalid_scope",
        error_description: "Invalid scope: /read-limited",
      });
    }

    // A narrower scope is a refresh the client may still make, and its token is the public view.
    const narrow = await refreshTokens(server, {
      refreshToken: token.refresh_token,
      client: "member",
      extra: { scope: "openid", revoke_old: "false" },
    });
    expect(narrow.status).toBe(200);
    expect(narrow.json?.scope).toBe("openid");
    expect(
      emailsOf(await getRecord(server, RICH_EMAIL, { token: String(narrow.json?.access_token) })),
    ).toEqual(PUBLIC_ONLY);

    // The refusal revoked nothing: with the membership back, the full refresh works.
    await setMember(true);
    const restored = await refreshTokens(server, {
      refreshToken: token.refresh_token,
      client: "member",
    });
    expect(restored.status).toBe(200);
    expect(restored.json?.scope).toBe("openid /read-limited");
    expect(
      emailsOf(await getRecord(server, RICH_EMAIL, { token: String(restored.json?.access_token) })),
    ).toEqual(WITH_LIMITED);
  });
});

describe("a user locked or deactivated after sign-in", () => {
  for (const state of ["locked", "deactivated"] as const) {
    const apply = (orcid: string) => patchUser(orcid, { [state]: true });
    const restore = (orcid: string) => patchUser(orcid, { [state]: false });
    const refusal = (orcid: string) => ({
      error: "invalid_grant",
      error_description: `iD ${orcid} is ${state} and cannot receive a token`,
    });

    describe(state, () => {
      test("the code exchange is 400 invalid_grant, and the code is gone", async () => {
        const { code } = await authorizeAs(server, { orcid: IDS.rich, scope: "/authenticate" });
        await apply(IDS.rich);
        const refused = await exchangeCode(server, { code });
        expect(refused.status).toBe(400);
        expect(refused.json).toEqual(refusal(IDS.rich));
        // The code was consumed, so restoring the user does not bring it back.
        await restore(IDS.rich);
        const again = await exchangeCode(server, { code });
        expect(again.json?.error_description).toBe(`Invalid authorization code: ${code}`);
      });

      test("the refresh grant is 400 invalid_grant, and works again once the user is restored", async () => {
        const token = await obtainToken(server, { orcid: IDS.rich, scope: "/authenticate" });
        await apply(IDS.rich);
        const refused = await refreshTokens(server, { refreshToken: token.refresh_token });
        expect(refused.status).toBe(400);
        expect(refused.json).toEqual(refusal(IDS.rich));
        // The refusal revoked nothing.
        await restore(IDS.rich);
        const resumed = await refreshTokens(server, { refreshToken: token.refresh_token });
        expect(resumed.status).toBe(200);
      });

      test("userinfo is ORCID's 403, and answers again once the user is restored", async () => {
        const token = await obtainToken(server, { orcid: IDS.rich, scope: "openid" });
        expect((await userinfo(token.access_token)).status).toBe(200);
        await apply(IDS.rich);
        const refused = await userinfo(token.access_token);
        expect(refused.status).toBe(403);
        expect(await refused.json()).toEqual({
          error: "access_denied",
          "error-description": "access_token is invalid",
        });
        await restore(IDS.rich);
        expect((await userinfo(token.access_token)).status).toBe(200);
      });

      test("the record API answers 409, as it always has", async () => {
        const token = await obtainToken(server, {
          orcid: IDS.rich,
          scope: "/read-limited",
          client: "member",
        });
        await apply(IDS.rich);
        const reply = await getRecord(server, RICH_EMAIL, { token: token.access_token });
        expect([reply.status, (reply.json as { "error-code": number })["error-code"]]).toEqual([
          409,
          state === "locked" ? 9018 : 9044,
        ]);
      });
    });
  }
});

/** `prompt=none` with a session cookie: where the browser is sent. */
async function silentSignIn(cookie: string): Promise<string> {
  const response = await fetch(
    authorizeUrl(server.baseUrl, {
      client_id: CLIENTS.member.client_id,
      response_type: "code",
      scope: "openid",
      redirect_uri: REDIRECT_URI,
      prompt: "none",
    }),
    { redirect: "manual", headers: { cookie } },
  );
  expect(response.status).toBe(302);
  return response.headers.get("location") ?? "";
}

describe("a user that is deleted, then created again with the same iD", () => {
  test("nothing issued to the old user works for the new one", async () => {
    const original = (await server.admin<Record<string, unknown>>("GET", `/users/${IDS.rich}`))
      .body;
    // A token pair, a live session, and a code nobody has exchanged yet.
    const signedIn = await authorizeAs(server, {
      orcid: IDS.rich,
      scope: "openid /read-limited",
      client: "member",
    });
    const token = await exchangeCode(server, { code: signedIn.code, client: "member" });
    const pending = await authorizeAs(server, {
      orcid: IDS.rich,
      scope: "openid /read-limited",
      client: "member",
    });
    const accessToken = String(token.json?.access_token);
    const refreshToken = String(token.json?.refresh_token);
    const cookie = signedIn.cookie ?? "";
    expect(cookie).not.toBe("");
    expect(emailsOf(await getRecord(server, RICH_EMAIL, { token: accessToken }))).toEqual(
      WITH_LIMITED,
    );
    expect(await silentSignIn(cookie)).toContain("code=");

    expect((await server.admin("DELETE", `/users/${IDS.rich}`)).status).toBe(204);
    const recreated = await server.admin("POST", "/users", original);
    expect(recreated.status).toBe(201);

    // The access token is unknown, not merely refused: the record API answers 401, not a view.
    const read = await getRecord(server, RICH_EMAIL, { token: accessToken });
    expect(read.status).toBe(401);
    expect((await userinfo(accessToken)).status).toBe(403);
    const refreshed = await refreshTokens(server, { refreshToken, client: "member" });
    expect([refreshed.status, refreshed.json?.error]).toEqual([400, "invalid_grant"]);
    const exchanged = await exchangeCode(server, { code: pending.code, client: "member" });
    expect([exchanged.status, exchanged.json?.error]).toEqual([400, "invalid_grant"]);
    expect(await silentSignIn(cookie)).toBe(`${REDIRECT_URI}#login_required`);

    // The new user starts clean and signs in as usual.
    const fresh = await obtainToken(server, {
      orcid: IDS.rich,
      scope: "openid /read-limited",
      client: "member",
    });
    expect(emailsOf(await getRecord(server, RICH_EMAIL, { token: fresh.access_token }))).toEqual(
      WITH_LIMITED,
    );
  });

  test("another user's tokens and sessions are not touched", async () => {
    const other = await obtainToken(server, {
      orcid: IDS.carberry,
      scope: "openid",
      client: "member",
    });
    await server.admin("DELETE", `/users/${IDS.rich}`);
    expect((await userinfo(other.access_token)).status).toBe(200);
  });
});

describe("a user that is replaced with PUT", () => {
  test("keeps their tokens, session, and codes: it is the same person, edited", async () => {
    const signedIn = await authorizeAs(server, {
      orcid: IDS.rich,
      scope: "openid /read-limited",
      client: "member",
    });
    const token = await exchangeCode(server, { code: signedIn.code, client: "member" });
    const pending = await authorizeAs(server, {
      orcid: IDS.rich,
      scope: "openid /read-limited",
      client: "member",
    });
    const accessToken = String(token.json?.access_token);
    const cookie = signedIn.cookie ?? "";

    const current = (await server.admin<Record<string, unknown>>("GET", `/users/${IDS.rich}`)).body;
    const renamed = { ...current, name: { ...(current.name as object), given_names: "Renamed" } };
    expect((await server.admin("PUT", `/users/${IDS.rich}`, renamed)).status).toBe(200);

    const info = await userinfo(accessToken);
    expect(info.status).toBe(200);
    expect(((await info.json()) as { given_name: string }).given_name).toBe("Renamed");
    expect(emailsOf(await getRecord(server, RICH_EMAIL, { token: accessToken }))).toEqual(
      WITH_LIMITED,
    );
    expect(await silentSignIn(cookie)).toContain("code=");
    const refreshed = await refreshTokens(server, {
      refreshToken: String(token.json?.refresh_token),
      client: "member",
    });
    expect(refreshed.status).toBe(200);
    expect((await exchangeCode(server, { code: pending.code, client: "member" })).status).toBe(200);
  });
});
