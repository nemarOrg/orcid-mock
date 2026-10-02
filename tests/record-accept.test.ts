// `Accept` negotiation and the Content-Type echo, row by row from the live observations of
// pub.orcid.org/v3.0 on 2026-10-01, against /v3.0/{iD}/email of a record whose only email is
// private (so the body is the empty container).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { IDS, RECORD_USERS_FILE } from "./fixtures/record";
import { startTestServer, type TestServer } from "./harness";
import { ERROR_KEYS, getRecord, rawRequest } from "./helpers/record";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer({ users: RECORD_USERS_FILE });
}, 10_000);
beforeEach(() => server.reset());
afterAll(() => server.stop());

const PATH = `/v3.0/${IDS.carberry}/email`;
const COMPACT = `{"last-modified-date":null,"email":[],"path":"/${IDS.carberry}/email"}`;
const PRETTY = [
  "{",
  '  "last-modified-date" : null,',
  '  "email" : [ ],',
  `  "path" : "/${IDS.carberry}/email"`,
  "}",
].join("\n");

describe("the JSON representations", () => {
  test("application/json is compact, with the 74 bytes and the UTF-8 Content-Type ORCID sends", async () => {
    const reply = await getRecord(server, PATH, { accept: "application/json" });
    expect(reply.status).toBe(200);
    expect(reply.headers.get("content-type")).toBe("application/json;charset=UTF-8");
    expect(reply.text).toBe(COMPACT);
    expect(new TextEncoder().encode(reply.text).length).toBe(74);
  });

  for (const type of ["application/vnd.orcid+json", "application/orcid+json"]) {
    test(`${type} is pretty-printed, byte for byte, and echoed`, async () => {
      const reply = await getRecord(server, PATH, { accept: type });
      expect(reply.status).toBe(200);
      expect(reply.headers.get("content-type")).toBe(`${type};charset=UTF-8`);
      expect(reply.text).toBe(PRETTY);
      expect(new TextEncoder().encode(reply.text).length).toBe(91);
    });
  }

  test("a charset the client names is kept and no second one is added", async () => {
    const reply = await getRecord(server, PATH, {
      accept: "application/vnd.orcid+json;charset=utf-8",
    });
    expect(reply.headers.get("content-type")).toBe("application/vnd.orcid+json;charset=utf-8");
    expect(reply.text).toBe(PRETTY);
  });

  test("the client's capitalization is echoed", async () => {
    const reply = await getRecord(server, PATH, { accept: "APPLICATION/JSON" });
    expect(reply.headers.get("content-type")).toBe("APPLICATION/JSON;charset=UTF-8");
    expect(reply.text).toBe(COMPACT);
    const mixed = await getRecord(server, PATH, { accept: "Application/Vnd.Orcid+Json" });
    expect(mixed.headers.get("content-type")).toBe("Application/Vnd.Orcid+Json;charset=UTF-8");
    expect(mixed.text).toBe(PRETTY);
  });

  test("a list is read in order of quality, so a JSON type before a wildcard wins", async () => {
    const reply = await getRecord(server, PATH, { accept: "application/json, text/plain, */*" });
    expect(reply.status).toBe(200);
    expect(reply.headers.get("content-type")).toBe("application/json;charset=UTF-8");
    expect(reply.text).toBe(COMPACT);
  });

  test("orcid-mock choice: spaces around parameters and a q-value are not echoed", async () => {
    const spaced = await getRecord(server, PATH, { accept: "application/json; charset=utf-8" });
    expect(spaced.headers.get("content-type")).toBe("application/json;charset=utf-8");
    const weighted = await getRecord(server, PATH, { accept: "application/orcid+json;q=0.9" });
    expect(weighted.headers.get("content-type")).toBe("application/orcid+json;charset=UTF-8");
    expect(weighted.text).toBe(PRETTY);
    const quoted = await getRecord(server, PATH, { accept: 'application/json;charset="utf-8"' });
    expect(quoted.headers.get("content-type")).toBe('application/json;charset="utf-8"');
  });

  test("q-values order the choice, q=0 excludes a type, and a wildcard does not beat a named type", async () => {
    const cases: Array<[string, string]> = [
      ["application/json;q=0.5, application/orcid+json;q=0.9", PRETTY],
      ["application/xml;q=0, application/json", COMPACT],
      ["text/csv, application/json;q=0.5", COMPACT],
      ["*/*;q=0.1, application/json;q=0.05", "xml"],
      // orcid-mock choice: equal quality, so the more specific range goes first.
      ["*/*, application/json", COMPACT],
    ];
    for (const [accept, expected] of cases) {
      const reply = await getRecord(server, PATH, { accept });
      if (expected === "xml") expect(reply.status).toBe(406);
      else expect(reply.text).toBe(expected);
    }
  });

  test("a range that is not a media type is skipped, and nothing left is a 406", async () => {
    expect((await getRecord(server, PATH, { accept: "json" })).status).toBe(406);
    expect((await getRecord(server, PATH, { accept: "application/json;q=abc" })).status).toBe(406);
    const rescued = await getRecord(server, PATH, { accept: "garbage, application/json" });
    expect(rescued.status).toBe(200);
    expect(rescued.text).toBe(COMPACT);
  });
});

const XML_BODY_START =
  '{"response-code":406,"developer-message":"406 Not Acceptable: orcid-mock serves JSON only';

describe("what real ORCID answers with XML is a documented 406", () => {
  const rows: Array<[string, string | undefined]> = [
    ["*/*", "*/*"],
    ["text/plain, */*", "text/plain, */*"],
    ["application/*", "application/*"],
    ["application/xml", "application/xml"],
    ["application/vnd.orcid+xml", "application/vnd.orcid+xml"],
    ["application/orcid+xml", "application/orcid+xml"],
    ["application/json;q=0.5, application/xml", "application/json;q=0.5, application/xml"],
  ];
  for (const [label, accept] of rows) {
    test(`Accept: ${label}`, async () => {
      const reply = await getRecord(server, PATH, { accept: accept as string });
      expect(reply.status).toBe(406);
      // Like the standard 406, no Content-Type at all.
      expect(reply.headers.get("content-type")).toBeNull();
      expect(reply.text.startsWith(XML_BODY_START)).toBe(true);
      const body = reply.json as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(ERROR_KEYS);
      expect(body["response-code"]).toBe(406);
      expect(body["error-code"]).toBe(9001);
      expect(body["user-message"]).toBe(
        "ORCID could not process the data, because they were invalid.",
      );
      const developer = String(body["developer-message"]);
      expect(developer).toContain("real ORCID would answer this request");
      expect(developer).toContain(`Accept: ${accept}`);
      expect(developer).toContain("with XML");
      expect(developer).toContain("Send Accept: application/json");
    });
  }

  test("no Accept header at all (a raw request: fetch always sends one)", async () => {
    const reply = await rawRequest(server, "GET", PATH);
    expect(reply.status).toBe(406);
    expect(reply.headers.get("content-type")).toBeNull();
    const developer = String((reply.json as Record<string, unknown>)["developer-message"]);
    expect(developer).toContain("(no Accept header)");
  });

  test("a blank Accept header counts as none", async () => {
    const reply = await rawRequest(server, "GET", PATH, { Accept: "" });
    expect(reply.status).toBe(406);
    expect(String((reply.json as Record<string, unknown>)["developer-message"])).toContain(
      "(no Accept header)",
    );
  });
});

describe("a type ORCID does not produce is the standard 406 / 9001", () => {
  for (const accept of ["text/csv", "text/html", "text/*", "application/ld+json", "image/png"]) {
    test(`Accept: ${accept}`, async () => {
      const reply = await getRecord(server, PATH, { accept });
      expect(reply.status).toBe(406);
      expect(reply.headers.get("content-type")).toBeNull();
      expect(reply.text).toBe(
        '{"response-code":406,"developer-message":"400 Bad Request: There is an issue with your data or the API endpoint. 405 Method Not Allowed: Endpoint and method mismatch. 415 Unsupported Media Type: data must be in XML or JSON format. Full validation error: HTTP 406 Not Acceptable","user-message":"ORCID could not process the data, because they were invalid.","error-code":9001,"more-info":"https://members.orcid.org/api/resources/troubleshooting"}',
      );
    });
  }
});

describe("errors follow the negotiated style", () => {
  test("a 404 for application/vnd.orcid+json is pretty-printed and echoes the type", async () => {
    const reply = await getRecord(server, "/v3.0/0000-0000-0000-0000/email", {
      accept: "application/vnd.orcid+json",
    });
    expect(reply.status).toBe(404);
    expect(reply.headers.get("content-type")).toBe("application/vnd.orcid+json;charset=UTF-8");
    expect(reply.text).toBe(
      [
        "{",
        '  "response-code" : 404,',
        '  "developer-message" : "404 Not Found: The resource was not found.",',
        '  "user-message" : "The resource was not found.",',
        '  "error-code" : 9016,',
        '  "more-info" : "https://members.orcid.org/api/resources/troubleshooting"',
        "}",
      ].join("\n"),
    );
  });

  test("a 404 for application/json is compact with the UTF-8 Content-Type", async () => {
    const reply = await getRecord(server, "/v3.0/0000-0000-0000-0000/email");
    expect(reply.status).toBe(404);
    expect(reply.headers.get("content-type")).toBe("application/json;charset=UTF-8");
    expect(reply.text).toBe(
      '{"response-code":404,"developer-message":"404 Not Found: The resource was not found.","user-message":"The resource was not found.","error-code":9016,"more-info":"https://members.orcid.org/api/resources/troubleshooting"}',
    );
  });
});
