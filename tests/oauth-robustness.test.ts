// No /oauth route reaches the generic 500 handler through a real request, so there is no 500 body
// to assert on; this file instead pins that malformed input is always answered as a 4xx or a
// redirect, never a 5xx, so a change that lets one through fails here.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { startTestServer, type TestServer } from "./harness";
import { authorizeUrl, CLIENTS, REDIRECT_URI, userIds } from "./helpers/oauth";

let server: TestServer;
let alder: string;
beforeAll(async () => {
  server = await startTestServer();
}, 10_000);
beforeEach(async () => {
  await server.reset();
  alder = (await userIds(server)).alder;
});
afterAll(() => server.stop());

const FORM = { "content-type": "application/x-www-form-urlencoded" };

/** Malformed UTF-8 and percent-encoding that a parser might throw on. */
const WEIRD = [
  "%",
  "%E0%A4%A",
  "%FF%FE",
  "%00",
  "%0d%0a",
  "[",
  "http://[::1",
  "\\",
  "a".repeat(100_000),
];

describe("malformed input never reaches a 5xx", () => {
  test("GET /oauth/authorize with malformed parameters, cookies, and a huge state", async () => {
    for (const weird of WEIRD) {
      for (const name of [
        "state",
        "nonce",
        "login_as",
        "prompt",
        "scope",
        "client_id",
        "redirect_uri",
      ]) {
        const url = new URL(
          authorizeUrl(server.baseUrl, {
            client_id: CLIENTS.public.client_id,
            response_type: "code",
            scope: "openid",
            redirect_uri: REDIRECT_URI,
            login_as: alder,
          }),
        );
        // Written into the query string raw, so the server sees the malformed bytes.
        const raw = `${url.search}&${name}=${weird}`;
        const response = await fetch(`${server.baseUrl}/oauth/authorize${raw}`, {
          redirect: "manual",
        });
        expect(response.status).toBeLessThan(500);
        await response.arrayBuffer();
      }
      const withCookie = await fetch(
        authorizeUrl(server.baseUrl, {
          client_id: CLIENTS.public.client_id,
          response_type: "code",
          scope: "openid",
          redirect_uri: REDIRECT_URI,
          prompt: "none",
        }),
        { redirect: "manual", headers: { cookie: `orcid_mock_session=${weird.slice(0, 200)}` } },
      ).catch(() => null);
      if (withCookie) expect(withCookie.status).toBeLessThan(500);
    }
  });

  test("POST bodies that are not valid UTF-8 or form syntax", async () => {
    const bodies: Array<string | Uint8Array<ArrayBuffer>> = [
      new Uint8Array([0xff, 0xfe, 0x3d, 0x80]),
      "grant_type=%FF&client_id=%E0%A4%A&client_secret=%",
      "=&=&&&",
      "grant_type",
      "x".repeat(200_000),
      ...WEIRD.map((weird) => `grant_type=${weird}&token=${weird}&code=${weird}`),
    ];
    for (const path of ["/oauth/token", "/oauth/revoke", "/oauth/authorize"]) {
      for (const body of bodies) {
        const response = await fetch(`${server.baseUrl}${path}`, {
          method: "POST",
          headers: FORM,
          body: new Blob([body]),
        });
        expect(response.status).toBeLessThan(500);
        await response.arrayBuffer();
      }
    }
  });

  test("Authorization headers that are not credentials", async () => {
    const credentials = [
      "Basic",
      "Basic ",
      "Basic %%%",
      "Basic ====",
      `Basic ${btoa("é:é")}`,
      "Bearer",
      "x",
    ];
    for (const authorization of credentials) {
      for (const path of ["/oauth/token", "/oauth/revoke"]) {
        const response = await fetch(`${server.baseUrl}${path}`, {
          method: "POST",
          headers: { ...FORM, authorization },
          body: "grant_type=client_credentials&token=x",
        });
        expect(response.status).toBeLessThan(500);
        await response.arrayBuffer();
      }
    }
    // Basic credentials that decode to bytes that are not UTF-8.
    const response = await fetch(`${server.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { ...FORM, authorization: "Basic /+8=" },
      body: "grant_type=client_credentials",
    });
    expect(response.status).toBe(401);
  });

  test("a state of ORCID's documented maximum, 2000 characters, round-trips", async () => {
    // https://info.orcid.org/documentation/integration-guide/customizing-the-sign-in-register-screen/
    const state = "s".repeat(2000);
    const response = await fetch(
      authorizeUrl(server.baseUrl, {
        client_id: CLIENTS.public.client_id,
        response_type: "code",
        scope: "/authenticate",
        redirect_uri: REDIRECT_URI,
        login_as: alder,
        state,
      }),
      { redirect: "manual" },
    );
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location") ?? "").searchParams.get("state")).toBe(state);
  });
});
