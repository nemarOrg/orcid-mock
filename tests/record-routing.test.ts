// Routing, methods, and the headers on every /v3.0 response (observed on pub.orcid.org/v3.0 on
// 2026-10-01).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { IDS, RECORD_USERS_FILE } from "./fixtures/record";
import { startTestServer, type TestServer } from "./harness";
import {
  ERROR_KEYS,
  getRecord,
  RECORD_HEADERS,
  type RecordReply,
  rawRequest,
} from "./helpers/record";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer({ users: RECORD_USERS_FILE });
}, 10_000);
beforeEach(() => server.reset());
afterAll(() => server.stop());

const EMAIL = `/v3.0/${IDS.carberry}/email`;
const STANDARD_9001 =
  "400 Bad Request: There is an issue with your data or the API endpoint. " +
  "405 Method Not Allowed: Endpoint and method mismatch. " +
  "415 Unsupported Media Type: data must be in XML or JSON format. ";

function expectHeaders(reply: RecordReply) {
  for (const [name, value] of Object.entries(RECORD_HEADERS)) {
    expect(reply.headers.get(name)).toBe(value);
  }
}

function expect9001(reply: RecordReply, status: number, detail: string) {
  expect(reply.status).toBe(status);
  // Real ORCID sends no Content-Type on a 9001 (observed).
  expect(reply.headers.get("content-type")).toBeNull();
  const body = reply.json as Record<string, unknown>;
  expect(Object.keys(body)).toEqual(ERROR_KEYS);
  expect(body).toEqual({
    "response-code": status,
    "developer-message": `${STANDARD_9001}Full validation error: ${detail}`,
    "user-message": "ORCID could not process the data, because they were invalid.",
    "error-code": 9001,
    "more-info": "https://members.orcid.org/api/resources/troubleshooting",
  });
}

describe("paths that are not read paths", () => {
  test("GET /v3.0/ is a 406 / 9001", async () => {
    const reply = await getRecord(server, "/v3.0/");
    expect9001(reply, 406, "HTTP 406 Not Acceptable");
    expectHeaders(reply);
  });

  test("/v3.0/ is a resource: OPTIONS is a 200, HEAD a 406, and any other method a 405", async () => {
    const options = await getRecord(server, "/v3.0/", { method: "OPTIONS" });
    expect(options.status).toBe(200);
    expect(options.text).toBe("");
    expect(options.headers.get("allow")).toBe("HEAD,GET,OPTIONS");
    expect(options.headers.get("content-type")).toBe("application/json;charset=UTF-8");
    expectHeaders(options);
    expect((await getRecord(server, "/v3.0/", { method: "HEAD" })).status).toBe(406);
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect9001(await getRecord(server, "/v3.0/", { method }), 405, "HTTP 405 Method Not Allowed");
    }
  });

  test("GET /v3.0/ is a 406 whatever Accept says", async () => {
    for (const accept of ["application/vnd.orcid+json", "text/csv", "*/*"]) {
      expect9001(await getRecord(server, "/v3.0/", { accept }), 406, "HTTP 406 Not Acceptable");
    }
  });

  for (const path of [
    "/v3.0",
    `/v3.0/${IDS.carberry}/bogus`,
    `/v3.0/${IDS.carberry}/email/extra/segments`,
    "/v3.0/a/b/c/d",
    `/v3.0/${IDS.carberry}/work/`,
    `/v3.0/${IDS.carberry}/email.json`,
  ]) {
    test(`GET ${path} is a 404 / 9001 with the headers`, async () => {
      const reply = await getRecord(server, path);
      expect9001(reply, 404, "HTTP 404 Not Found");
      expectHeaders(reply);
    });
  }

  test("an unrouted path answers the same whatever Accept says", async () => {
    const reply = await getRecord(server, `/v3.0/${IDS.carberry}/bogus`, { accept: "text/csv" });
    expect9001(reply, 404, "HTTP 404 Not Found");
  });
});

describe("methods", () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    test(`${method} on a read path is a 405 / 9001 with no Content-Type`, async () => {
      const reply = await getRecord(server, EMAIL, { method });
      expect9001(reply, 405, "HTTP 405 Method Not Allowed");
      expectHeaders(reply);
    });
  }

  test("the method is judged before the record, so an unknown iD is still a 405", async () => {
    const reply = await getRecord(server, "/v3.0/0000-0000-0000-0000/email", { method: "POST" });
    expect9001(reply, 405, "HTTP 405 Method Not Allowed");
  });

  test("a wrong method on an unrouted path is the 404", async () => {
    expect9001(
      await getRecord(server, `/v3.0/${IDS.carberry}/bogus`, { method: "POST" }),
      404,
      "HTTP 404 Not Found",
    );
  });

  test("HEAD is a GET without the body, headers and Content-Type included", async () => {
    const head = await getRecord(server, EMAIL, { method: "HEAD" });
    const get = await getRecord(server, EMAIL);
    expect(head.status).toBe(200);
    expect(head.text).toBe("");
    expect(head.headers.get("content-type")).toBe("application/json;charset=UTF-8");
    expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
    expectHeaders(head);
  });

  test("HEAD on an error is the error's status and headers", async () => {
    const head = await getRecord(server, "/v3.0/0000-0000-0000-0000/email", { method: "HEAD" });
    expect(head.status).toBe(404);
    expect(head.text).toBe("");
    expectHeaders(head);
  });

  test("OPTIONS is a 200 with an empty body and Allow: HEAD,GET,OPTIONS", async () => {
    const reply = await getRecord(server, EMAIL, { method: "OPTIONS" });
    expect(reply.status).toBe(200);
    expect(reply.text).toBe("");
    expect(reply.headers.get("allow")).toBe("HEAD,GET,OPTIONS");
    // The Content-Type follows Accept; JSON is echoed.
    expect(reply.headers.get("content-type")).toBe("application/json;charset=UTF-8");
    expect(reply.headers.get("access-control-allow-methods")).toBeNull();
    expectHeaders(reply);
  });

  test("OPTIONS with no Accept names ORCID's XML type, and a preflight adds the CORS lists", async () => {
    const reply = await rawRequest(server, "OPTIONS", EMAIL, {
      Origin: "http://example.test",
      "Access-Control-Request-Method": "GET",
    });
    expect(reply.status).toBe(200);
    expect(reply.headers.get("content-type")).toBe(
      "application/vnd.orcid+xml;qs=0.5;charset=UTF-8",
    );
    expect(reply.headers.get("allow")).toBe("HEAD,GET,OPTIONS");
    expect(reply.headers.get("access-control-allow-methods")).toBe("GET, POST, PUT, DELETE");
    expect(reply.headers.get("access-control-allow-headers")).toBe(
      "X-Requested-With,Origin,Content-Type, Accept",
    );
    expect(reply.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("OPTIONS does not look at the record: an unknown or locked iD is still a 200", async () => {
    for (const orcid of ["0000-0000-0000-0000", IDS.locked, IDS.deprecated]) {
      const reply = await getRecord(server, `/v3.0/${orcid}/email`, { method: "OPTIONS" });
      expect([orcid, reply.status]).toEqual([orcid, 200]);
    }
  });

  test("OPTIONS on an unrouted path is the 404", async () => {
    expect9001(
      await getRecord(server, `/v3.0/${IDS.carberry}/bogus`, { method: "OPTIONS" }),
      404,
      "HTTP 404 Not Found",
    );
  });
});

describe("a trailing slash", () => {
  test("is served on a read path, with the same body", async () => {
    const plain = await getRecord(server, EMAIL);
    const slashed = await getRecord(server, `${EMAIL}/`);
    expect(slashed.status).toBe(200);
    expect(slashed.text).toBe(plain.text);
  });
});

describe("headers on every response", () => {
  const requests: Array<[string, () => Promise<RecordReply>]> = [
    ["a 200", () => getRecord(server, EMAIL)],
    ["a 200 in pretty style", () => getRecord(server, EMAIL, { accept: "application/orcid+json" })],
    ["an unknown iD", () => getRecord(server, "/v3.0/0000-0000-0000-0000/email")],
    ["an unsupported Accept", () => getRecord(server, EMAIL, { accept: "text/csv" })],
    ["an XML Accept", () => getRecord(server, EMAIL, { accept: "*/*" })],
    ["a wrong method", () => getRecord(server, EMAIL, { method: "POST" })],
    ["an unrouted path", () => getRecord(server, "/v3.0/a/b/c")],
    ["/v3.0/", () => getRecord(server, "/v3.0/")],
    ["a bad token", () => getRecord(server, EMAIL, { token: "not-a-token" })],
    ["a deprecated record", () => getRecord(server, `/v3.0/${IDS.deprecated}/email`)],
    ["a locked record", () => getRecord(server, `/v3.0/${IDS.locked}/email`)],
  ];
  for (const [label, request] of requests) {
    test(label, async () => {
      expectHeaders(await request());
    });
  }

  test("nothing outside /v3.0 gets them", async () => {
    const reply = await fetch(`${server.baseUrl}/__admin/health`);
    expect(reply.headers.get("access-control-allow-origin")).toBeNull();
    expect(reply.headers.get("cache-control")).toBeNull();
  });
});

describe("no real request reaches the generic 500 handler", () => {
  // None of these is a bug to fix: ORCID's own answers (a 404 for an unknown iD, 400 / 9006 for a
  // bad element) cover them. They are here so a change that lets one throw fails a test, since
  // the 500 handler is the only place a stack trace could ever be logged.
  const exotic: Array<[string, number]> = [
    ["/v3.0/%E0%A4%A/email", 404],
    ["/v3.0/%/email", 404],
    [`/v3.0/${IDS.rich}/email?access_token=%E0%A4%A`, 401],
    [`/v3.0/${IDS.rich}/work/%E0%A4%A`, 404],
    [`/v3.0/${IDS.rich}/works/%E0%A4%A`, 400],
    [`/v3.0/${IDS.rich}/works/${"1,".repeat(5000)}`, 400],
    [`/v3.0/${IDS.rich}/work/${"9".repeat(500)}`, 404],
    [`/v3.0/${IDS.rich}/works/${"9".repeat(500)}`, 400],
    [`/v3.0/${IDS.rich}/other-names/${"9".repeat(500)}`, 404],
    [`/v3.0/${IDS.deprecated}/%E0%A4%A`, 404],
  ];
  for (const [path, status] of exotic) {
    test(path.slice(0, 70), async () => {
      const reply = await rawRequest(server, "GET", path, { Accept: "application/json" });
      expect(reply.status).toBe(status);
      expect(reply.text).not.toContain("Something went wrong");
      expect(reply.headers.get("cache-control")).toBe(RECORD_HEADERS["cache-control"]);
    });
  }
});
