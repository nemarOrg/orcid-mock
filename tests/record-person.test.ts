// The person-level sections for an anonymous reader: every route's 200 shape against an object
// written out here, with key order checked on the raw text (`JSON.stringify` of the expected
// object keeps its key order), then the single-item reads and their errors, and NEMAR's contract.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { IDS, RECORD_USERS_FILE } from "./fixtures/record";
import { startTestServer, type TestServer } from "./harness";
import { getRecord, loadStamp } from "./helpers/record";

let server: TestServer;
let T: number;
beforeAll(async () => {
  server = await startTestServer({ users: RECORD_USERS_FILE });
  T = await loadStamp(server);
}, 10_000);
beforeEach(() => server.reset());
afterAll(() => server.stop());

const stamp = () => ({ value: T });
const source = (orcid: string, name: string) => ({
  "source-orcid": {
    uri: `${server.publicBaseUrl}/${orcid}`,
    path: orcid,
    host: new URL(server.publicBaseUrl).host,
  },
  "source-client-id": null,
  "source-name": { value: name },
  "assertion-origin-orcid": null,
  "assertion-origin-client-id": null,
  "assertion-origin-name": null,
});

/** The raw text must be exactly `JSON.stringify(expected)`: values, and key order. */
async function expectBody(path: string, expected: unknown, opts: { token?: string } = {}) {
  const reply = await getRecord(server, path, opts);
  expect(reply.status).toBe(200);
  expect(reply.json).toEqual(expected);
  expect(reply.text).toBe(JSON.stringify(expected));
}

// ---- Josiah Carberry -------------------------------------------------------------------------

const C = IDS.carberry;
const carberrySource = () => source(C, "Josiah Carberry");
const carberryItem = (put: number, content: string, index: number, segment: string) => ({
  "created-date": stamp(),
  "last-modified-date": stamp(),
  source: carberrySource(),
  content,
  visibility: "public",
  path: `/${C}/${segment}/${put}`,
  "put-code": put,
  "display-index": index,
});
const carberry = () => ({
  name: {
    "created-date": stamp(),
    "last-modified-date": stamp(),
    "given-names": { value: "Josiah" },
    "family-name": { value: "Carberry" },
    "credit-name": null,
    source: null,
    visibility: "public",
    path: C,
  },
  otherNames: {
    "last-modified-date": stamp(),
    "other-name": [
      carberryItem(5001, "Josiah Stinkney Carberry", 3, "other-names"),
      carberryItem(5002, "J. S. Carberry", 2, "other-names"),
      carberryItem(5003, "J. Carberry", 1, "other-names"),
    ],
    path: `/${C}/other-names`,
  },
  biography: {
    "created-date": stamp(),
    "last-modified-date": stamp(),
    content: "A fictional professor of psychoceramics.\r\n\r\nUsed to demonstrate ORCID.",
    visibility: "public",
    path: `/${C}/biography`,
  },
  researcherUrls: {
    "last-modified-date": stamp(),
    "researcher-url": [
      {
        "created-date": stamp(),
        "last-modified-date": stamp(),
        source: carberrySource(),
        "url-name": "Hartwell Institute page",
        url: { value: "https://example.test/carberry" },
        visibility: "public",
        path: `/${C}/researcher-urls/5201`,
        "put-code": 5201,
        "display-index": 2,
      },
    ],
    path: `/${C}/researcher-urls`,
  },
  // The only email is private: the public container is empty, and its date is null.
  emails: { "last-modified-date": null, email: [], path: `/${C}/email` },
  addresses: { "last-modified-date": null, address: [], path: `/${C}/address` },
  keywords: {
    "last-modified-date": stamp(),
    keyword: [carberryItem(5101, "psychoceramics", 3, "keywords")],
    path: `/${C}/keywords`,
  },
  externalIdentifiers: {
    "last-modified-date": stamp(),
    "external-identifier": [
      {
        "created-date": stamp(),
        "last-modified-date": stamp(),
        source: carberrySource(),
        "external-id-type": "Scopus Author ID",
        "external-id-value": "7000000001",
        "external-id-url": { value: "https://example.test/scopus/7000000001" },
        "external-id-relationship": "self",
        visibility: "public",
        path: `/${C}/external-identifiers/5301`,
        "put-code": 5301,
        "display-index": 0,
      },
    ],
    path: `/${C}/external-identifiers`,
  },
});

describe("Josiah Carberry's person-level sections", () => {
  test("/email is the empty container, because the only email is private", async () => {
    await expectBody(`/v3.0/${C}/email`, carberry().emails);
  });

  test("/address is the empty container under its singular key", async () => {
    await expectBody(`/v3.0/${C}/address`, carberry().addresses);
  });

  test("/other-names is in display-index order, 3 then 2 then 1, with numeric indexes", async () => {
    await expectBody(`/v3.0/${C}/other-names`, carberry().otherNames);
  });

  test("/keywords", async () => {
    await expectBody(`/v3.0/${C}/keywords`, carberry().keywords);
  });

  test("/researcher-urls", async () => {
    await expectBody(`/v3.0/${C}/researcher-urls`, carberry().researcherUrls);
  });

  test("/external-identifiers has no normalized keys", async () => {
    await expectBody(`/v3.0/${C}/external-identifiers`, carberry().externalIdentifiers);
  });

  test("/biography is a plain `content` string, with no source and no put-code", async () => {
    await expectBody(`/v3.0/${C}/biography`, carberry().biography);
  });

  test("/personal-details: name, other names, biography; its date is the latest of those", async () => {
    const c = carberry();
    await expectBody(`/v3.0/${C}/personal-details`, {
      "last-modified-date": stamp(),
      name: c.name,
      "other-names": c.otherNames,
      biography: c.biography,
      path: `/${C}/personal-details`,
    });
  });

  test("/person has ten keys in ORCID's order, with the plural emails and addresses", async () => {
    const c = carberry();
    const expected = {
      "last-modified-date": stamp(),
      name: c.name,
      "other-names": c.otherNames,
      biography: c.biography,
      "researcher-urls": c.researcherUrls,
      emails: c.emails,
      addresses: c.addresses,
      keywords: c.keywords,
      "external-identifiers": c.externalIdentifiers,
      path: `/${C}/person`,
    };
    await expectBody(`/v3.0/${C}/person`, expected);
    const keys = Object.keys((await getRecord(server, `/v3.0/${C}/person`)).json as object);
    expect(keys).toEqual([
      "last-modified-date",
      "name",
      "other-names",
      "biography",
      "researcher-urls",
      "emails",
      "addresses",
      "keywords",
      "external-identifiers",
      "path",
    ]);
  });

  test("a trailing slash gives the same body", async () => {
    const a = await getRecord(server, `/v3.0/${C}/person`);
    const b = await getRecord(server, `/v3.0/${C}/person/`);
    expect(b.text).toBe(a.text);
  });

  test("the standalone sections equal the nested ones", async () => {
    const person = (await getRecord(server, `/v3.0/${C}/person`)).json as Record<string, unknown>;
    for (const [section, key] of [
      ["email", "emails"],
      ["address", "addresses"],
      ["other-names", "other-names"],
      ["keywords", "keywords"],
      ["external-identifiers", "external-identifiers"],
      ["researcher-urls", "researcher-urls"],
    ] as const) {
      const standalone = (await getRecord(server, `/v3.0/${C}/${section}`)).json;
      expect(standalone).toEqual(person[key]);
    }
  });
});

// ---- Marisol Quenby, public view -------------------------------------------------------------

const R = IDS.rich;
const richSource = () => source(R, "M. Quenby");
const richItem = (put: number, segment: string, index: number, fields: object) => ({
  "created-date": stamp(),
  "last-modified-date": stamp(),
  source: richSource(),
  ...fields,
  visibility: "public",
  path: `/${R}/${segment}/${put}`,
  "put-code": put,
  "display-index": index,
});

describe("a record with public, limited, and private items shows only the public ones", () => {
  test("/other-names", async () => {
    await expectBody(`/v3.0/${R}/other-names`, {
      "last-modified-date": stamp(),
      "other-name": [richItem(1001, "other-names", 2, { content: "Mari Quenby" })],
      path: `/${R}/other-names`,
    });
  });

  test("/email has the public email, with put-code and path null and no display-index", async () => {
    await expectBody(`/v3.0/${R}/email`, {
      "last-modified-date": stamp(),
      email: [
        {
          "created-date": stamp(),
          "last-modified-date": stamp(),
          source: richSource(),
          email: "marisol.quenby@example.test",
          path: null,
          visibility: "public",
          verified: true,
          primary: true,
          "put-code": null,
        },
      ],
      path: `/${R}/email`,
    });
  });

  test("/address", async () => {
    await expectBody(`/v3.0/${R}/address`, {
      "last-modified-date": stamp(),
      address: [richItem(1101, "address", 1, { country: { value: "NZ" } })],
      path: `/${R}/address`,
    });
  });

  test("/keywords, /researcher-urls (a null url-name stays), and /external-identifiers", async () => {
    await expectBody(`/v3.0/${R}/keywords`, {
      "last-modified-date": stamp(),
      keyword: [richItem(1201, "keywords", 2, { content: "signal processing" })],
      path: `/${R}/keywords`,
    });
    await expectBody(`/v3.0/${R}/researcher-urls`, {
      "last-modified-date": stamp(),
      "researcher-url": [
        richItem(1401, "researcher-urls", 1, {
          "url-name": "Lab",
          url: { value: "https://example.test/quenby" },
        }),
      ],
      path: `/${R}/researcher-urls`,
    });
    await expectBody(`/v3.0/${R}/external-identifiers`, {
      "last-modified-date": stamp(),
      "external-identifier": [
        richItem(1301, "external-identifiers", 1, {
          "external-id-type": "Scopus Author ID",
          "external-id-value": "7000000002",
          "external-id-url": { value: "https://example.test/scopus/7000000002" },
          "external-id-relationship": "self",
        }),
      ],
      path: `/${R}/external-identifiers`,
    });
  });

  test("the source name is the credit name when there is one", async () => {
    const reply = await getRecord(server, `/v3.0/${R}/keywords`);
    const body = reply.json as { keyword: Array<{ source: { "source-name": unknown } }> };
    expect(body.keyword[0]?.source["source-name"]).toEqual({ value: "M. Quenby" });
  });

  test("the name keeps its credit name, and the biography is shown", async () => {
    const reply = await getRecord(server, `/v3.0/${R}/personal-details`);
    const body = reply.json as { name: Record<string, unknown>; biography: { content: string } };
    expect(body.name["credit-name"]).toEqual({ value: "M. Quenby" });
    expect(body.biography.content).toBe("A fictional researcher of fictional signals.");
  });
});

// ---- NEMAR's contract ------------------------------------------------------------------------

describe("what NEMAR reads: /personal-details name", () => {
  test("a name gives given-names and family-name values", async () => {
    const reply = await getRecord(server, `/v3.0/${R}/personal-details`, {
      accept: "application/json",
    });
    const body = reply.json as {
      name: { "given-names": { value: string }; "family-name": { value: string } };
    };
    expect(body.name["given-names"].value).toBe("Marisol");
    expect(body.name["family-name"].value).toBe("Quenby");
  });

  test("a missing family name is `family-name: null`, and a missing biography is null", async () => {
    const reply = await getRecord(server, `/v3.0/${IDS.nullFamily}/personal-details`);
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({
      "last-modified-date": stamp(),
      name: {
        "created-date": stamp(),
        "last-modified-date": stamp(),
        "given-names": { value: "Ondine" },
        "family-name": null,
        "credit-name": null,
        source: null,
        visibility: "public",
        path: IDS.nullFamily,
      },
      "other-names": {
        "last-modified-date": null,
        "other-name": [],
        path: `/${IDS.nullFamily}/other-names`,
      },
      biography: null,
      path: `/${IDS.nullFamily}/personal-details`,
    });
  });

  test("a private name is `name: null`, in personal-details and in person", async () => {
    const details = await getRecord(server, `/v3.0/${IDS.privateName}/personal-details`);
    expect(details.status).toBe(200);
    const body = details.json as Record<string, unknown>;
    expect(body.name).toBeNull();
    // The biography is separate: it is public here, so it is still shown.
    expect((body.biography as { content: string }).content).toBe(
      "A public biography under a private name.",
    );
    // Only the name was hidden, and the date is the latest of what is left: the biography's.
    expect(body["last-modified-date"]).toEqual(stamp());

    const person = await getRecord(server, `/v3.0/${IDS.privateName}/person`);
    expect((person.json as Record<string, unknown>).name).toBeNull();
  });

  test("a private name leaves the items' source name null: there is no public display name", async () => {
    const reply = await getRecord(server, `/v3.0/${IDS.privateName}/keywords`);
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({
      "last-modified-date": stamp(),
      keyword: [
        {
          "created-date": stamp(),
          "last-modified-date": stamp(),
          source: {
            "source-orcid": {
              uri: `${server.publicBaseUrl}/${IDS.privateName}`,
              path: IDS.privateName,
              host: new URL(server.publicBaseUrl).host,
            },
            "source-client-id": null,
            "source-name": null,
            "assertion-origin-orcid": null,
            "assertion-origin-client-id": null,
            "assertion-origin-name": null,
          },
          content: "anonymity",
          visibility: "public",
          path: `/${IDS.privateName}/keywords/6001`,
          "put-code": 6001,
          "display-index": 0,
        },
      ],
      path: `/${IDS.privateName}/keywords`,
    });
  });
});

// ---- Biography -------------------------------------------------------------------------------

describe("/biography", () => {
  test("a record with no biography at all is 404 / 9041 (source only), and person shows null", async () => {
    const reply = await getRecord(server, `/v3.0/${IDS.nullFamily}/biography`);
    expect(reply.status).toBe(404);
    expect(reply.json).toEqual({
      "response-code": 404,
      "developer-message": "404 Not Found: Biography for the given record is null.",
      "user-message": "There is no biography for the given record.",
      "error-code": 9041,
      "more-info": "https://members.orcid.org/api/resources/troubleshooting",
    });
    const person = await getRecord(server, `/v3.0/${IDS.nullFamily}/person`);
    expect((person.json as Record<string, unknown>).biography).toBeNull();
  });

  test("a biography that is not public is 403 / 9039 (observed), and person shows null", async () => {
    const reply = await getRecord(server, `/v3.0/${IDS.bioPrivate}/biography`);
    expect(reply.status).toBe(403);
    expect(reply.json).toEqual({
      "response-code": 403,
      "developer-message":
        "403 Forbidden: The item is not public and cannot be accessed with the Public API.",
      "user-message": "The client application is forbidden to perform the action.",
      "error-code": 9039,
      "more-info": "https://members.orcid.org/api/resources/troubleshooting",
    });
    const person = await getRecord(server, `/v3.0/${IDS.bioPrivate}/person`);
    expect((person.json as Record<string, unknown>).biography).toBeNull();
    const details = await getRecord(server, `/v3.0/${IDS.bioPrivate}/personal-details`);
    expect((details.json as Record<string, unknown>).biography).toBeNull();
  });

  test("the error follows the negotiated style", async () => {
    const reply = await getRecord(server, `/v3.0/${IDS.bioPrivate}/biography`, {
      accept: "application/orcid+json",
    });
    expect(reply.headers.get("content-type")).toBe("application/orcid+json;charset=UTF-8");
    expect(reply.text.startsWith('{\n  "response-code" : 403,')).toBe(true);
  });
});

// ---- Single items ----------------------------------------------------------------------------

describe("a single person-level item", () => {
  test("is the same object the container holds", async () => {
    const container = (await getRecord(server, `/v3.0/${C}/other-names`)).json as {
      "other-name": unknown[];
    };
    const item = await getRecord(server, `/v3.0/${C}/other-names/5002`);
    expect(item.status).toBe(200);
    expect(item.json).toEqual(container["other-name"][1]);
    expect(item.text).toBe(JSON.stringify(container["other-name"][1]));
  });

  test("every section serves its items by put-code", async () => {
    for (const [segment, put] of [
      ["other-names", 5001],
      ["keywords", 5101],
      ["researcher-urls", 5201],
      ["external-identifiers", 5301],
    ] as const) {
      const reply = await getRecord(server, `/v3.0/${C}/${segment}/${put}`);
      expect(reply.status).toBe(200);
      expect((reply.json as { "put-code": number })["put-code"]).toBe(put);
    }
    const address = await getRecord(server, `/v3.0/${R}/address/1101`);
    expect((address.json as { path: string }).path).toBe(`/${R}/address/1101`);
  });

  test("an unknown put-code, another record's, and another section's are 404 / 9016", async () => {
    for (const path of [
      `/v3.0/${C}/other-names/9999`,
      // Marisol's put-code under Carberry.
      `/v3.0/${C}/other-names/1001`,
      // A keyword's put-code in the other-names section.
      `/v3.0/${C}/other-names/5101`,
      `/v3.0/${C}/other-names/-1`,
    ]) {
      const reply = await getRecord(server, path);
      expect(reply.status).toBe(404);
      expect((reply.json as { "error-code": number })["error-code"]).toBe(9016);
    }
  });

  test("a limited or private item is 403 / 9039, not 404", async () => {
    for (const put of [1002, 1003]) {
      const reply = await getRecord(server, `/v3.0/${R}/other-names/${put}`);
      expect(reply.status).toBe(403);
      expect(reply.json).toEqual({
        "response-code": 403,
        "developer-message":
          "403 Forbidden: The item is not public and cannot be accessed with the Public API.",
        "user-message": "The client application is forbidden to perform the action.",
        "error-code": 9039,
        "more-info": "https://members.orcid.org/api/resources/troubleshooting",
      });
    }
  });

  test("a put-code is read as a Java Long: a sign and leading zeros are fine", async () => {
    for (const put of ["+5002", "05002", "0005002"]) {
      const reply = await getRecord(server, `/v3.0/${C}/other-names/${put}`);
      expect(reply.status).toBe(200);
      expect((reply.json as { "put-code": number })["put-code"]).toBe(5002);
    }
  });

  test("a put-code that is not a number is 404 / 9001 with the NumberFormatException, as observed", async () => {
    for (const raw of ["abc", "1.5", "5002x", "99999999999999999999"]) {
      const reply = await getRecord(server, `/v3.0/${C}/other-names/${raw}`);
      expect(reply.status).toBe(404);
      // Unlike an unrouted path, this 9001 has a Content-Type (observed).
      expect(reply.headers.get("content-type")).toBe("application/json;charset=UTF-8");
      expect(reply.json).toEqual({
        "response-code": 404,
        "developer-message":
          "400 Bad Request: There is an issue with your data or the API endpoint. 405 Method Not Allowed: Endpoint and method mismatch. 415 Unsupported Media Type: data must be in XML or JSON format. " +
          `Full validation error: HTTP 404 Not Found (java.lang.NumberFormatException: For input string: "${raw}")`,
        "user-message": "ORCID could not process the data, because they were invalid.",
        "error-code": 9001,
        "more-info": "https://members.orcid.org/api/resources/troubleshooting",
      });
    }
  });

  test("the record's state is checked before the item", async () => {
    const reply = await getRecord(server, `/v3.0/${IDS.locked}/other-names/1`);
    expect(reply.status).toBe(409);
  });
});
