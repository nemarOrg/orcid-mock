// `Accept` negotiation and the Content-Type echo, row by row from the live observations of
// pub.orcid.org/v3.0 on 2026-10-01, against /v3.0/{iD}/email of a record whose only email is
// private (so the body is the empty container).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { IDS, RECORD_USERS_FILE } from "./fixtures/record";
import { startTestServer, type TestServer } from "./harness";
import { ERROR_KEYS, getRecord, RECORD_HEADERS, rawRequest } from "./helpers/record";

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

  // Every row below was observed on pub.orcid.org/v3.0 on 2026-10-01 against the same path.
  test("the echo drops q and qs, keeps the parameters before them, and unquotes a token value", async () => {
    const rows: Array<[string, string]> = [
      ["application/json; charset=utf-8", "application/json;charset=utf-8"],
      ["application/orcid+json;q=0.9", "application/orcid+json;charset=UTF-8"],
      ['application/json;charset="utf-8"', "application/json;charset=utf-8"],
      ["application/json;foo=bar;q=0.5", "application/json;foo=bar;charset=UTF-8"],
      ["application/json;q=0.5;foo=bar", "application/json;foo=bar;charset=UTF-8"],
      ["application/json;qs=0.9, application/xml", "application/json;charset=UTF-8"],
      ["application/json;Charset=UTF-8", "application/json;charset=UTF-8"],
      ["application/json;charset=utf-8;charset=ascii", "application/json;charset=ascii"],
      ['application/json;x="a;b"', 'application/json;x="a;b";charset=UTF-8'],
      ['application/json;x="a b"', 'application/json;x="a b";charset=UTF-8'],
      ['application/json;x=""', "application/json;x=;charset=UTF-8"],
      ["application/json;q=0.5;;", "application/json;charset=UTF-8"],
      ["application/json ; q=0.5", "application/json;charset=UTF-8"],
      ["APPLICATION/vnd.ORCID+json", "APPLICATION/vnd.ORCID+json;charset=UTF-8"],
    ];
    for (const [accept, contentType] of rows) {
      const reply = await getRecord(server, PATH, { accept });
      expect([accept, reply.status, reply.headers.get("content-type")]).toEqual([
        accept,
        200,
        contentType,
      ]);
    }
  });

  test("a wildcard type with a subtype names the type with that subtype", async () => {
    const orcid = await getRecord(server, PATH, { accept: "*/orcid+json" });
    expect(orcid.headers.get("content-type")).toBe("application/orcid+json;charset=UTF-8");
    expect(orcid.text).toBe(PRETTY);
    const json = await getRecord(server, PATH, { accept: "*/json" });
    expect(json.headers.get("content-type")).toBe("application/json;charset=UTF-8");
    expect(json.text).toBe(COMPACT);
    expect((await getRecord(server, PATH, { accept: "*/xml" })).status).toBe(406);
  });

  test("q-values order the choice, and a q of 0 is still acceptable", async () => {
    const rows: Array<[string, string]> = [
      ["application/json;q=0.5, application/orcid+json;q=0.9", PRETTY],
      ["application/xml;q=0, application/json", COMPACT],
      ["application/json;q=0", COMPACT],
      ["text/csv, application/json;q=0.5", COMPACT],
      ["application/*;q=0.5, application/json", COMPACT],
      ["application/*;q=0.9, application/json;q=0.9", COMPACT],
      ["*/*, application/json", COMPACT],
      ["application/json, */*", COMPACT],
      ["application/json;q=0.5;q=0.9", COMPACT],
      ["application/json;q=0.5, application/json;q=0.9", COMPACT],
      ["application/json,", COMPACT],
      ["application/json;q=.5", COMPACT],
      ["application/json;q=1.", COMPACT],
      ["application/json;q=1.000", COMPACT],
      ["application/json;Q=0.5", COMPACT],
      ["garbage, application/json", COMPACT],
    ];
    for (const [accept, body] of rows) {
      const reply = await getRecord(server, PATH, { accept });
      expect([accept, reply.status, reply.text]).toEqual([accept, 200, body]);
    }
    // A higher quality for a wildcard than for the JSON type means XML.
    for (const accept of [
      "*/*;q=0.9, application/json;q=0.8",
      "application/json;q=0.5, application/xml",
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    ]) {
      expect([accept, (await getRecord(server, PATH, { accept })).status]).toEqual([accept, 406]);
    }
  });

  test("JSON against XML at equal quality: ORCID's server weight decides, then the order written", async () => {
    // `application/json` and `application/xml` carry no weight, so they tie and the first listed
    // wins; every ORCID type is lighter (`vnd.orcid+xml` 0.5, `vnd.orcid+json` 0.4, `orcid+xml`
    // 0.3, `orcid+json` 0.2), so a plain type beats it and the heavier of two ORCID types wins.
    const rows: Array<[string, string]> = [
      ["application/json, application/xml", "application/json;charset=UTF-8"],
      ["application/xml, application/json", "xml"],
      ["application/vnd.orcid+xml, application/json", "application/json;charset=UTF-8"],
      ["application/json, application/vnd.orcid+xml", "application/json;charset=UTF-8"],
      ["application/orcid+xml, application/json", "application/json;charset=UTF-8"],
      ["application/vnd.orcid+json, application/xml", "xml"],
      ["application/xml, application/vnd.orcid+json", "xml"],
      ["application/vnd.orcid+xml, application/vnd.orcid+json", "xml"],
      ["application/vnd.orcid+json, application/vnd.orcid+xml", "xml"],
      ["application/orcid+json, application/orcid+xml", "xml"],
      ["application/orcid+json, application/vnd.orcid+xml", "xml"],
      [
        "application/vnd.orcid+json, application/orcid+json",
        "application/vnd.orcid+json;charset=UTF-8",
      ],
      [
        "application/orcid+json, application/vnd.orcid+json",
        "application/vnd.orcid+json;charset=UTF-8",
      ],
      ["application/json, application/orcid+json", "application/json;charset=UTF-8"],
      ["application/orcid+json, application/json", "application/json;charset=UTF-8"],
      ["application/json;q=0.5, application/xml;q=0.5", "application/json;charset=UTF-8"],
      ["application/xml;q=0.5, application/json;q=0.5", "xml"],
      ["application/vnd.orcid+xml;q=0.5, application/json;q=0.5", "application/json;charset=UTF-8"],
      ["application/xml;qs=0.1, application/json;qs=0.9", "xml"],
    ];
    for (const [accept, expected] of rows) {
      const reply = await getRecord(server, PATH, { accept });
      const got = reply.status === 200 ? reply.headers.get("content-type") : "xml";
      expect([accept, got]).toEqual([accept, expected]);
    }
  });

  test("a bare word is a type with any subtype, and matches nothing", async () => {
    expect((await getRecord(server, PATH, { accept: "json" })).status).toBe(406);
    expect((await getRecord(server, PATH, { accept: "garbage" })).status).toBe(406);
    // `application` alone is `application/*`, which gets XML.
    const xml = await getRecord(server, PATH, { accept: "application" });
    expect(xml.status).toBe(406);
    expect(String((xml.json as { "developer-message": string })["developer-message"])).toContain(
      "with XML",
    );
  });
});

describe("an Accept header that does not parse is ORCID's 400 HTML page", () => {
  const malformed = [
    "application/json;q=abc",
    "application/json;q=1.5",
    "application/json;q=-1",
    "application/json;q=",
    "application/json;q=0.12345",
    "application/json;foo",
    "application/json;q=0.5;foo",
    "application/json;q = 0.5",
    "application/json;x=a b",
    "application/",
    "/json",
    "application/json/x",
    "appl ication/json",
    ",application/json",
    "application/json,,application/xml",
  ];
  for (const accept of malformed) {
    test(`Accept: ${accept}`, async () => {
      const reply = await getRecord(server, PATH, { accept });
      expect(reply.status).toBe(400);
      expect(reply.headers.get("content-type")).toBe("text/html;charset=utf-8");
      expect(reply.headers.get("content-language")).toBe("en");
      expect(reply.text).toContain("HTTP Status 400 - Bad Request");
      for (const [name, value] of Object.entries(RECORD_HEADERS)) {
        expect(reply.headers.get(name)).toBe(value);
      }
    });
  }

  test("every read path and OPTIONS answer it, and /v3.0/ too", async () => {
    for (const [path, method] of [
      [`/v3.0/${IDS.carberry}/record`, "GET"],
      [`/v3.0/0000-0000-0000-0000/email`, "GET"],
      [`/v3.0/${IDS.carberry}/work/abc`, "GET"],
      [`/v3.0/${IDS.carberry}/works/1,1`, "GET"],
      [PATH, "OPTIONS"],
      ["/v3.0/", "GET"],
    ] as const) {
      const reply = await getRecord(server, path, { method, accept: "application/json;q=abc" });
      expect([path, method, reply.status]).toEqual([path, method, 400]);
    }
  });

  test("an unrouted path, a wrong method, and a bad token come first", async () => {
    const accept = "application/json;q=abc";
    expect((await getRecord(server, `/v3.0/${IDS.carberry}/bogus`, { accept })).status).toBe(404);
    expect((await getRecord(server, PATH, { accept, method: "POST" })).status).toBe(405);
    expect((await getRecord(server, PATH, { accept, token: "bad" })).status).toBe(401);
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
