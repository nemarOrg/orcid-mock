// What a change through the admin API does to state that is already live: a client that loses its
// membership, a user that is locked or deactivated, a user that is deleted or replaced (ADR 0009).
// Every token comes from the real token endpoint and every check is a real request.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { IDS, RECORD_USERS_FILE } from "./fixtures/record";
import { startTestServer, type TestServer } from "./harness";
import { authorizeAs, CLIENTS, exchangeCode, obtainToken, refreshTokens } from "./helpers/oauth";
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
