// The one way a request reaches the generic 500 handler on the OpenID Connect routes: a stored
// signing key that cannot be used. Nothing a client sends can produce one, so the key is put in
// the real store directly; the app, its routes, and the server are the real ones, and every check
// is an HTTP request.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createMockApp } from "../src/bootstrap";
import { STARTER_USERS_FILE } from "../src/fixtures/starter";
import { silentLogger } from "../src/log";
import { authorizeAs, exchangeCode } from "./helpers/oauth";

const GENERIC_500 = '{"error":"server_error","error_description":"Internal server error"}';

let baseUrl: string;
let aldersId: string;
let stop: () => void;

beforeAll(async () => {
  const config = { publicBaseUrl: "http://127.0.0.1:0", logLevel: "error" as const };
  const { app, store } = await createMockApp({
    users: STARTER_USERS_FILE,
    config,
    nowMs: Date.now(),
    log: silentLogger,
  });
  // Neither half is a usable RSA key: no modulus or exponent to publish, nothing to sign with.
  await store.putSigningKeyIfAbsent({
    kid: "orcid-mock-corrupt",
    private_jwk: { kty: "RSA" },
    public_jwk: { kty: "RSA" },
    created_ms: Date.now(),
  });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  baseUrl = `http://127.0.0.1:${server.port}`;
  config.publicBaseUrl = baseUrl;
  stop = () => server.stop(true);
  const users = (await (await fetch(`${baseUrl}/__admin/users`)).json()) as Array<{
    orcid: string;
    name: { given_names: string };
  }>;
  aldersId = users.find((user) => user.name.given_names === "Alder")?.orcid ?? "";
}, 10_000);
afterAll(() => stop());

describe("a stored signing key that cannot be used", () => {
  test("the JWKS answers the generic OAuth-shaped 500, with no key material in the body", async () => {
    const response = await fetch(`${baseUrl}/oauth/jwks`);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe(GENERIC_500);
  });

  test("an openid exchange answers the generic 500, and an exchange without openid is untouched", async () => {
    const reachable = { baseUrl };
    const openid = await authorizeAs(reachable, { orcid: aldersId, scope: "openid" });
    const failed = await exchangeCode(reachable, { code: openid.code });
    expect(failed.status).toBe(500);
    expect(failed.text).toBe(GENERIC_500);

    const plain = await authorizeAs(reachable, { orcid: aldersId, scope: "/authenticate" });
    expect((await exchangeCode(reachable, { code: plain.code })).status).toBe(200);
  });

  test("discovery and userinfo need no key and still answer", async () => {
    expect((await fetch(`${baseUrl}/.well-known/openid-configuration`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/oauth/userinfo`)).status).toBe(403);
  });
});
