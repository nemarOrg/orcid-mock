import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { startTestServer, type TestServer } from "./harness";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
}, 10_000);
beforeEach(() => server.reset());
afterAll(() => server.stop());

const STACK_FRAME = /\n\s+at |\bat\s+\S+\s+\(.*:\d+:\d+\)|node_modules|\.ts:\d+/;

async function get(path: string, init?: RequestInit) {
  const response = await fetch(`${server.baseUrl}${path}`, init);
  const text = await response.text();
  expect(text).not.toMatch(STACK_FRAME);
  return { response, text, json: JSON.parse(text) as Record<string, unknown> };
}

describe("an unrouted /v3.0 path answers in ORCID's record-API shape", () => {
  for (const path of ["/v3.0/x", "/v3.0", "/v3.0/", "/v3.0/0000-0002-1825-0097/record"]) {
    test(`GET ${path}`, async () => {
      const { response, text, json } = await get(path);
      expect(response.status).toBe(404);
      // Real ORCID sends no Content-Type on a 9001 (record-API research, section 1.4).
      expect(response.headers.get("content-type")).toBeNull();
      expect(Object.keys(json)).toEqual([
        "response-code",
        "developer-message",
        "user-message",
        "error-code",
        "more-info",
      ]);
      expect(json["response-code"]).toBe(404);
      expect(json["error-code"]).toBe(9001);
      expect(json["user-message"]).toBe(
        "ORCID could not process the data, because they were invalid.",
      );
      expect(json["more-info"]).toBe("https://members.orcid.org/api/resources/troubleshooting");
      expect(json["developer-message"]).toBe(
        "400 Bad Request: There is an issue with your data or the API endpoint. " +
          "405 Method Not Allowed: Endpoint and method mismatch. " +
          "415 Unsupported Media Type: data must be in XML or JSON format. " +
          "Full validation error: HTTP 404 Not Found",
      );
      expect(text.startsWith('{"response-code":404,"developer-message":')).toBe(true);
    });
  }

  test("a method that has no route answers the same way", async () => {
    const { response, json } = await get("/v3.0/anything", { method: "POST" });
    expect(response.status).toBe(404);
    expect(json["error-code"]).toBe(9001);
  });
});

describe("an unrouted OAuth or discovery path answers in OAuth's shape", () => {
  for (const path of [
    "/oauth/x",
    "/oauth",
    "/oauth/",
    "/.well-known/x",
    "/.well-known/openid-configuration",
  ]) {
    test(`GET ${path}`, async () => {
      const { response, json } = await get(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(json).toEqual({ error: "invalid_request", error_description: "Not found" });
    });
  }
});

describe("everything else answers in the admin shape", () => {
  for (const path of ["/__admin/x", "/__admin", "/nope", "/", "/__admin/users/x/y"]) {
    test(`GET ${path}`, async () => {
      const { response, json } = await get(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(json).toEqual({ error: "not_found" });
    });
  }

  test("a method with no route on a real admin path is 404 in the same shape", async () => {
    const { response, json } = await get("/__admin/health", { method: "POST" });
    expect(response.status).toBe(404);
    expect(json).toEqual({ error: "not_found" });
  });
});

describe("error bodies never leak internals", () => {
  test("a malformed request body does not echo a parser message or a stack", async () => {
    const { response, text } = await get("/__admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"name": ',
    });
    expect(response.status).toBe(400);
    expect(text).not.toContain("JSON Parse error");
    expect(text).not.toContain("Unexpected");
  });
});
