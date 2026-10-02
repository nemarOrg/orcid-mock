import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { startTestServer, type TestServer } from "./harness";
import {
  basicAuth,
  CLIENTS,
  clientCredentials,
  clientFields,
  obtainToken,
  postForm,
  refreshTokens,
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

const errorText = (error: string, description: string) =>
  `{"error":"${error}","error_description":"${description}"}`;

const revoke = (
  token: string | undefined,
  client: "public" | "member" = "public",
  headers: Record<string, string> = {},
) => postForm(server, "/oauth/revoke", { ...clientFields(client), token }, headers);

const signIn = () => obtainToken(server, { orcid: ids.alder as string, scope: "/authenticate" });

describe("POST /oauth/revoke", () => {
  test("revoking an access token answers 200 with an empty body, and kills the refresh token too", async () => {
    const token = await signIn();
    const reply = await revoke(token.access_token);
    expect(reply.status).toBe(200);
    expect(reply.text).toBe("");

    const refreshed = await refreshTokens(server, { refreshToken: token.refresh_token });
    expect(refreshed.status).toBe(400);
    expect(refreshed.text).toBe(
      errorText("invalid_grant", `Invalid refresh token: ${token.refresh_token}`),
    );
  });

  test("revoking a refresh token kills the pair as well", async () => {
    const token = await signIn();
    const reply = await revoke(token.refresh_token);
    expect(reply.status).toBe(200);
    expect(reply.text).toBe("");
    expect((await refreshTokens(server, { refreshToken: token.refresh_token })).status).toBe(400);
  });

  test("a client-credentials token can be revoked too", async () => {
    const credentials = await clientCredentials(server);
    expect((await revoke(String(credentials.json?.access_token))).status).toBe(200);
    const refreshed = await refreshTokens(server, {
      refreshToken: String(credentials.json?.refresh_token),
    });
    expect(refreshed.status).toBe(400);
  });

  test("HTTP Basic credentials authenticate the client, as at the token endpoint", async () => {
    const token = await signIn();
    const reply = await postForm(
      server,
      "/oauth/revoke",
      { token: token.access_token },
      {
        authorization: basicAuth("public"),
      },
    );
    expect(reply.status).toBe(200);
    expect((await refreshTokens(server, { refreshToken: token.refresh_token })).status).toBe(400);
  });

  test("an unknown token is a 200 with an empty body, as RFC 7009 asks", async () => {
    for (const token of ["00000000-0000-4000-8000-000000000000", "not-a-token", " "]) {
      const reply = await revoke(token);
      expect(reply.status).toBe(200);
      expect(reply.text).toBe("");
    }
  });

  test("revoking twice is still a 200, and an expired token can be revoked", async () => {
    const token = await signIn();
    expect((await revoke(token.access_token)).status).toBe(200);
    expect((await revoke(token.access_token)).status).toBe(200);
    expect((await revoke(token.refresh_token)).status).toBe(200);

    const old = await signIn();
    await server.admin("POST", "/clock", { advance_seconds: 631138520 });
    expect((await revoke(old.access_token)).status).toBe(200);
  });

  test("another client's token is a 400 unauthorized_client and is left alone", async () => {
    const token = await signIn();
    for (const presented of [token.access_token, token.refresh_token]) {
      const reply = await revoke(presented, "member");
      expect(reply.status).toBe(400);
      expect(reply.text).toBe(
        errorText("unauthorized_client", "Token was not issued to this client"),
      );
    }
    // Still good for its owner.
    expect((await refreshTokens(server, { refreshToken: token.refresh_token })).status).toBe(200);
  });

  test("a missing or empty token is a 400 invalid_request", async () => {
    for (const token of [undefined, ""]) {
      const reply = await revoke(token);
      expect(reply.status).toBe(400);
      expect(reply.text).toBe(errorText("invalid_request", "token is required"));
    }
  });

  test("a missing token is reported before the client is authenticated", async () => {
    const reply = await postForm(server, "/oauth/revoke", {});
    expect(reply.status).toBe(400);
    expect(reply.text).toBe(errorText("invalid_request", "token is required"));
  });

  test("client authentication fails as it does at the token endpoint", async () => {
    const token = await signIn();
    const wrong = await postForm(server, "/oauth/revoke", {
      client_id: CLIENTS.public.client_id,
      client_secret: "wrong",
      token: token.access_token,
    });
    expect(wrong.status).toBe(401);
    expect(wrong.text).toBe(
      '{"error_description":"Client authentication failed","error":"invalid_client"}',
    );
    const noSecret = await postForm(server, "/oauth/revoke", {
      client_id: CLIENTS.public.client_id,
      token: token.access_token,
    });
    expect(noSecret.status).toBe(401);
    expect(noSecret.text).toBe(errorText("invalid_request", "client_secret is required"));
    const noClient = await postForm(server, "/oauth/revoke", { token: token.access_token });
    expect(noClient.status).toBe(401);
    expect(noClient.text).toBe(errorText("invalid_request", "client_id is required"));
    const badBasic = await postForm(
      server,
      "/oauth/revoke",
      { token: token.access_token },
      {
        authorization: "Basic !!!",
      },
    );
    expect(badBasic.status).toBe(401);
    // None of those revoked anything.
    expect((await refreshTokens(server, { refreshToken: token.refresh_token })).status).toBe(200);
  });

  test("a JSON body and a GET are 415, as at the token endpoint", async () => {
    const json = await fetch(`${server.baseUrl}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...CLIENTS.public, token: "x" }),
    });
    expect(json.status).toBe(415);
    expect(await json.text()).toBe("Content-Type 'application/json' is not supported.");
    const get = await fetch(`${server.baseUrl}/oauth/revoke?token=x`);
    expect(get.status).toBe(415);
    expect(await get.text()).toBe("Content-Type 'null' is not supported.");
  });

  test("reset forgets tokens, so a revoke after it is the unknown-token 200", async () => {
    const token = await signIn();
    await server.reset();
    expect((await revoke(token.access_token)).status).toBe(200);
  });
});
