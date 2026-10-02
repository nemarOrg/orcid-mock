// The whole record (`/{iD}` and `/record`), `/activities`, `history`, and every absolute URL's
// dependence on PUBLIC_BASE_URL.
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
const host = () => new URL(server.publicBaseUrl).host;

const emptyAffiliations = (iD: string, segment: string) => ({
  "last-modified-date": null,
  "affiliation-group": [],
  path: `/${iD}/${segment}`,
});
const emptyGroups = (iD: string, segment: string) => ({
  "last-modified-date": null,
  group: [],
  path: `/${iD}/${segment}`,
});

/** The eleven containers of a record with no activities, in ORCID's order. */
const emptyActivities = (iD: string) => ({
  "last-modified-date": null,
  distinctions: emptyAffiliations(iD, "distinctions"),
  educations: emptyAffiliations(iD, "educations"),
  employments: emptyAffiliations(iD, "employments"),
  fundings: emptyGroups(iD, "fundings"),
  "invited-positions": emptyAffiliations(iD, "invited-positions"),
  memberships: emptyAffiliations(iD, "memberships"),
  "peer-reviews": emptyGroups(iD, "peer-reviews"),
  qualifications: emptyAffiliations(iD, "qualifications"),
  "research-resources": emptyGroups(iD, "research-resources"),
  services: emptyAffiliations(iD, "services"),
  works: emptyGroups(iD, "works"),
  path: `/${iD}/activities`,
});

describe("a record with nothing in it", () => {
  const N = IDS.nullFamily;
  const emptyPerson = () => ({
    "last-modified-date": null,
    name: {
      "created-date": stamp(),
      "last-modified-date": stamp(),
      "given-names": { value: "Ondine" },
      "family-name": null,
      "credit-name": null,
      source: null,
      visibility: "public",
      path: N,
    },
    "other-names": { "last-modified-date": null, "other-name": [], path: `/${N}/other-names` },
    biography: null,
    "researcher-urls": {
      "last-modified-date": null,
      "researcher-url": [],
      path: `/${N}/researcher-urls`,
    },
    emails: { "last-modified-date": null, email: [], path: `/${N}/email` },
    addresses: { "last-modified-date": null, address: [], path: `/${N}/address` },
    keywords: { "last-modified-date": null, keyword: [], path: `/${N}/keywords` },
    "external-identifiers": {
      "last-modified-date": null,
      "external-identifier": [],
      path: `/${N}/external-identifiers`,
    },
    path: `/${N}/person`,
  });

  test("/record: six keys, the identifier from PUBLIC_BASE_URL, and every container empty", async () => {
    const expected = {
      "orcid-identifier": { uri: `${server.publicBaseUrl}/${N}`, path: N, host: host() },
      preferences: { locale: "en" },
      history: {
        "creation-method": "WEBSITE",
        "completion-date": null,
        "submission-date": stamp(),
        "last-modified-date": stamp(),
        claimed: true,
        source: null,
        "deactivation-date": null,
        "verified-email": false,
        "verified-primary-email": false,
      },
      person: emptyPerson(),
      "activities-summary": emptyActivities(N),
      // The root path is `/{iD}`, not `/{iD}/record`.
      path: `/${N}`,
    };
    const reply = await getRecord(server, `/v3.0/${N}/record`);
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual(expected);
    expect(reply.text).toBe(JSON.stringify(expected));
  });

  test("/activities is the same activities summary, with eleven empty containers", async () => {
    const reply = await getRecord(server, `/v3.0/${N}/activities`);
    expect(reply.status).toBe(200);
    expect(reply.text).toBe(JSON.stringify(emptyActivities(N)));
  });

  test("/research-resources is always empty", async () => {
    const reply = await getRecord(server, `/v3.0/${N}/research-resources`);
    expect(reply.text).toBe(JSON.stringify(emptyGroups(N, "research-resources")));
  });
});

describe("the four spellings of the record's URL give one body", () => {
  test("/{iD}, /{iD}/, /{iD}/record, and /{iD}/record/", async () => {
    const bodies = await Promise.all(
      [
        `/v3.0/${IDS.carberry}`,
        `/v3.0/${IDS.carberry}/`,
        `/v3.0/${IDS.carberry}/record`,
        `/v3.0/${IDS.carberry}/record/`,
      ].map(async (path) => {
        const reply = await getRecord(server, path);
        expect(reply.status).toBe(200);
        return reply.text;
      }),
    );
    expect(new Set(bodies).size).toBe(1);
  });
});

describe("a populated record composes its sections", () => {
  test("person, activities-summary, and every container equal what their endpoints serve", async () => {
    for (const orcid of [IDS.carberry, IDS.rich, IDS.grouping]) {
      const record = (await getRecord(server, `/v3.0/${orcid}/record`)).json as Record<
        string,
        Record<string, unknown>
      >;
      expect(Object.keys(record)).toEqual([
        "orcid-identifier",
        "preferences",
        "history",
        "person",
        "activities-summary",
        "path",
      ]);
      expect(record.person).toEqual(
        (await getRecord(server, `/v3.0/${orcid}/person`)).json as never,
      );
      const activities = (await getRecord(server, `/v3.0/${orcid}/activities`)).json as Record<
        string,
        unknown
      >;
      expect(record["activities-summary"]).toEqual(activities);
      expect(Object.keys(activities)).toEqual([
        "last-modified-date",
        "distinctions",
        "educations",
        "employments",
        "fundings",
        "invited-positions",
        "memberships",
        "peer-reviews",
        "qualifications",
        "research-resources",
        "services",
        "works",
        "path",
      ]);
      for (const segment of [
        "employments",
        "educations",
        "qualifications",
        "fundings",
        "peer-reviews",
        "works",
        "distinctions",
        "invited-positions",
        "memberships",
        "services",
        "research-resources",
      ]) {
        const standalone = (await getRecord(server, `/v3.0/${orcid}/${segment}`)).json;
        expect(activities[segment]).toEqual(standalone as never);
      }
    }
  });

  test("the dates of a populated record are the stamp, and the root path has no segment", async () => {
    const record = (await getRecord(server, `/v3.0/${IDS.rich}/record`)).json as {
      person: Record<string, unknown>;
      "activities-summary": Record<string, unknown>;
      path: string;
    };
    expect(record.person["last-modified-date"]).toEqual(stamp());
    expect(record["activities-summary"]["last-modified-date"]).toEqual(stamp());
    expect(record.path).toBe(`/${IDS.rich}`);
  });
});

describe("history", () => {
  type History = Record<string, unknown>;
  const historyOf = async (orcid: string): Promise<History> =>
    ((await getRecord(server, `/v3.0/${orcid}/record`)).json as { history: History }).history;

  test("a private verified email still makes verified-email and verified-primary-email true", async () => {
    const history = await historyOf(IDS.carberry);
    expect(history["verified-email"]).toBe(true);
    expect(history["verified-primary-email"]).toBe(true);
    // The email itself stays hidden.
    const email = (await getRecord(server, `/v3.0/${IDS.carberry}/email`)).json;
    expect((email as { email: unknown[] }).email).toEqual([]);
  });

  test("verified-email looks at every email, verified-primary-email only at the primary one", async () => {
    const history = await historyOf(IDS.bioPrivate);
    expect(history["verified-email"]).toBe(true);
    expect(history["verified-primary-email"]).toBe(false);
  });

  test("a record with only unverified or no emails has both false", async () => {
    for (const orcid of [IDS.nullFamily, IDS.grouping]) {
      const history = await historyOf(orcid);
      expect(history["verified-email"]).toBe(false);
      expect(history["verified-primary-email"]).toBe(false);
    }
  });

  test("its date counts hidden items, while a hidden-only record's sections have none", async () => {
    const record = (await getRecord(server, `/v3.0/${IDS.allPrivate}/record`)).json as {
      history: Record<string, unknown>;
      person: Record<string, unknown>;
      "activities-summary": Record<string, unknown>;
    };
    expect(record.history["last-modified-date"]).toEqual(stamp());
    expect(record.history["submission-date"]).toEqual(stamp());
    expect(record.person["last-modified-date"]).toBeNull();
    expect(record["activities-summary"]["last-modified-date"]).toBeNull();
  });

  test("claimed comes from the fixture, defaulting to true, and the other keys are fixed", async () => {
    const history = await historyOf(IDS.rich);
    expect(history).toEqual({
      "creation-method": "WEBSITE",
      "completion-date": null,
      "submission-date": stamp(),
      "last-modified-date": stamp(),
      claimed: true,
      source: null,
      "deactivation-date": null,
      "verified-email": true,
      "verified-primary-email": true,
    });
  });
});

describe("every absolute URL derives from PUBLIC_BASE_URL, with its path prefix and host", () => {
  let prefixed: TestServer;
  const BASE = "https://orcid.example.test/staging";
  beforeAll(async () => {
    prefixed = await startTestServer({ users: RECORD_USERS_FILE, publicBaseUrl: BASE });
  }, 10_000);
  afterAll(() => prefixed.stop());

  test("the identifier, the sources, and a contributor's iD", async () => {
    const record = (await getRecord(prefixed, `/v3.0/${IDS.rich}/record`)).json as {
      "orcid-identifier": unknown;
    };
    expect(record["orcid-identifier"]).toEqual({
      uri: `${BASE}/${IDS.rich}`,
      path: IDS.rich,
      host: "orcid.example.test",
    });
    const text = (await getRecord(prefixed, `/v3.0/${IDS.rich}/work/2001`)).text;
    expect(text).toContain(`"uri":"${BASE}/${IDS.rich}"`);
    expect(text).toContain(`"uri":"${BASE}/${IDS.carberry}"`);
    // Nothing is derived from the Host header or the real socket.
    expect(text).not.toContain("127.0.0.1");
  });

  test("a deprecated record's Location and message", async () => {
    const reply = await getRecord(prefixed, `/v3.0/${IDS.deprecated}/email`);
    expect(reply.status).toBe(301);
    expect(reply.headers.get("location")).toBe(`${BASE}/v3.0/${IDS.primary}/email`);
    expect((reply.json as { "user-message": string })["user-message"]).toBe(
      `This account is deprecated. Please refer to account: ${BASE}/${IDS.primary}.`,
    );
  });

  test("the Host header does not matter", async () => {
    const reply = await getRecord(prefixed, `/v3.0/${IDS.rich}/record`, {
      headers: { host: "evil.example.test" },
    });
    expect(reply.text).not.toContain("evil.example.test");
    expect(reply.text).toContain(BASE);
  });
});
