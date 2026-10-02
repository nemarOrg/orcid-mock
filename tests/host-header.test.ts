// A `Host` header that does not parse must not change what the server answers: every absolute URL
// derives from PUBLIC_BASE_URL and none from `Host` (ADR 0001). `fetch` always sends a sane
// `Host`, so these requests go over a raw socket. Before the fix, each of these hosts made
// `new URL(c.req.url)` throw, and authorize answered 500.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { IDS, RECORD_USERS_FILE } from "./fixtures/record";
import { startTestServer, type TestServer } from "./harness";
import { CLIENTS, exchangeCode, REDIRECT_URI } from "./helpers/oauth";
import { rawRequest } from "./helpers/record";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer({ users: RECORD_USERS_FILE });
}, 10_000);
beforeEach(() => server.reset());
afterAll(() => server.stop());

/** Hosts that fail URL parsing: an unclosed bracket, a second colon, a bad escape, a huge port. */
const MALFORMED_HOSTS = ["[::1", "a:b:c", "%zz", "evil.example:99999"];

const AUTHORIZE = `/oauth/authorize?${new URLSearchParams({
  response_type: "code",
  client_id: CLIENTS.public.client_id,
  redirect_uri: REDIRECT_URI,
  scope: "/authenticate",
  state: "st&a=te",
  login_as: IDS.rich,
})}`;

describe("a malformed Host answers as a normal one would", () => {
  for (const host of MALFORMED_HOSTS) {
    describe(JSON.stringify(host), () => {
      test("authorize signs in and redirects with a code that exchanges", async () => {
        const reply = await rawRequest(server, "GET", AUTHORIZE, {}, host);
        expect(reply.status).toBe(302);
        const location = new URL(reply.headers.get("location") ?? "");
        expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
        expect(location.searchParams.get("state")).toBe("st&a=te");
        const code = location.searchParams.get("code") ?? "";
        const token = await exchangeCode(server, { code });
        expect(token.status).toBe(200);
        expect(token.json?.orcid).toBe(IDS.rich);
      });

      test("authorize reads every query parameter, so a bad one is the normal error", async () => {
        const path = AUTHORIZE.replace("response_type=code", "response_type=token");
        const normal = await rawRequest(server, "GET", path);
        const reply = await rawRequest(server, "GET", path, {}, host);
        expect([reply.status, reply.headers.get("location")]).toEqual([
          normal.status,
          normal.headers.get("location"),
        ]);
        expect(reply.headers.get("location")).toBe(
          `${REDIRECT_URI}#error=unsupported_response_type`,
        );
      });

      test("a record read is the normal 200, byte for byte", async () => {
        const path = `/v3.0/${IDS.rich}/email`;
        const normal = await rawRequest(server, "GET", path, { Accept: "application/json" });
        const reply = await rawRequest(server, "GET", path, { Accept: "application/json" }, host);
        expect(reply.status).toBe(200);
        expect(reply.text).toBe(normal.text);
      });

      test("a deprecated record's 301 points at PUBLIC_BASE_URL, with the path suffix", async () => {
        const path = `/v3.0/${IDS.deprecated}/email/?access_token=&x=1`;
        const reply = await rawRequest(server, "GET", path, { Accept: "application/json" }, host);
        expect(reply.status).toBe(301);
        expect(reply.headers.get("location")).toBe(
          `${server.publicBaseUrl}/v3.0/${IDS.primary}/email/`,
        );
      });
    });
  }
});

describe("a deprecated record's Location keeps the path as the client sent it", () => {
  test("percent-escapes in the suffix stay escaped, not decoded", async () => {
    const reply = await rawRequest(
      server,
      "GET",
      `/v3.0/${IDS.deprecated}/employment/%31%30%30%30`,
      {
        Accept: "application/json",
      },
    );
    expect(reply.status).toBe(301);
    expect(reply.headers.get("location")).toBe(
      `${server.publicBaseUrl}/v3.0/${IDS.primary}/employment/%31%30%30%30`,
    );
  });
});
