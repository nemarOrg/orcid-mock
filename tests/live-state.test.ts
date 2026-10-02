// What a change through the admin API does to state that is already live: a client that loses its
// membership, a user that is locked or deactivated, a user that is deleted or replaced (ADR 0009).
// Every token comes from the real token endpoint and every check is a real request.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { IDS, RECORD_USERS_FILE } from "./fixtures/record";
import { startTestServer, type TestServer } from "./harness";
import { CLIENTS, obtainToken, refreshTokens } from "./helpers/oauth";
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
