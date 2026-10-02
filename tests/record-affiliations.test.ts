// Employments, educations, and qualifications (and the four kinds that are always empty): the
// wire shape, ORCID's date ordering, grouping by external id, and the full single-item reads.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { IDS, RECORD_USERS_FILE } from "./fixtures/record";
import { startTestServer, type TestServer } from "./harness";
import { getRecord, loadStamp, type RecordReply } from "./helpers/record";

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

const HARTWELL = {
  name: "Hartwell Institute of Applied Psychoceramics",
  address: { city: "Hartwell", region: "CT", country: "US" },
  "disambiguated-organization": {
    "disambiguated-organization-identifier": "https://ror.org/00hartwell00",
    "disambiguation-source": "ROR",
  },
};
const BROWNLOW = {
  name: "Brownlow College",
  address: { city: "Brownlow", region: null, country: "GB" },
  "disambiguated-organization": null,
};

const date = (year: string, month?: string, day?: string) => ({
  year: { value: year },
  month: month === undefined ? null : { value: month },
  day: day === undefined ? null : { value: day },
});

async function expectBody(path: string, expected: unknown) {
  const reply = await getRecord(server, path);
  expect(reply.status).toBe(200);
  expect(reply.json).toEqual(expected);
  // Key order: the raw text is the expected object's own serialization.
  expect(reply.text).toBe(JSON.stringify(expected));
}

const C = IDS.carberry;
const carberrySummary = (kind: string, put: number, fields: object) => ({
  [`${kind}-summary`]: {
    "created-date": stamp(),
    "last-modified-date": stamp(),
    source: source(C, "Josiah Carberry"),
    "put-code": put,
    ...fields,
    "display-index": "0",
    visibility: "public",
    path: `/${C}/${kind}/${put}`,
  },
});

const employment5401 = {
  "department-name": "Psychoceramics",
  "role-title": "Professor",
  "start-date": date("1930", "03", "01"),
  "end-date": null,
  organization: HARTWELL,
  url: null,
  "external-ids": null,
};
const employment5402 = {
  "department-name": "Cracked Pots",
  "role-title": "Lecturer",
  "start-date": date("1929", "02"),
  "end-date": date("1930", "02", "28"),
  organization: BROWNLOW,
  url: null,
  "external-ids": null,
};

describe("Josiah Carberry's employments", () => {
  test("two groups, ongoing before ended, each with empty group ids and a one-key summary", async () => {
    await expectBody(`/v3.0/${C}/employments`, {
      "last-modified-date": stamp(),
      "affiliation-group": [
        {
          "last-modified-date": stamp(),
          "external-ids": { "external-id": [] },
          summaries: [carberrySummary("employment", 5401, employment5401)],
        },
        {
          "last-modified-date": stamp(),
          "external-ids": { "external-id": [] },
          summaries: [carberrySummary("employment", 5402, employment5402)],
        },
      ],
      path: `/${C}/employments`,
    });
  });

  test("the full item is the summary with put-code and path first, and no wrapper", async () => {
    await expectBody(`/v3.0/${C}/employment/5401`, {
      "created-date": stamp(),
      "last-modified-date": stamp(),
      source: source(C, "Josiah Carberry"),
      "put-code": 5401,
      path: `/${C}/employment/5401`,
      ...employment5401,
      "display-index": "0",
      visibility: "public",
    });
  });
});

describe("the empty sections", () => {
  test("every kind is an empty container with its own path and key", async () => {
    for (const [segment, key] of [
      ["educations", "affiliation-group"],
      ["qualifications", "affiliation-group"],
      ["distinctions", "affiliation-group"],
      ["invited-positions", "affiliation-group"],
      ["memberships", "affiliation-group"],
      ["services", "affiliation-group"],
    ]) {
      await expectBody(`/v3.0/${C}/${segment}`, {
        "last-modified-date": null,
        [key as string]: [],
        path: `/${C}/${segment}`,
      });
    }
  });

  test("the four kinds the fixture has no section for still have item routes: 404 / 9016, after the record's state", async () => {
    for (const kind of [
      "distinction",
      "invited-position",
      "membership",
      "service",
      "research-resource",
    ]) {
      const reply = await getRecord(server, `/v3.0/${C}/${kind}/1`);
      expect([kind, reply.status, (reply.json as { "error-code": number })["error-code"]]).toEqual([
        kind,
        404,
        9016,
      ]);
      expect((await getRecord(server, `/v3.0/${IDS.locked}/${kind}/1`)).status).toBe(409);
    }
  });

  test("an affiliation put-code of another kind is 400 / 9006, as ORCID's single table makes it", async () => {
    // 5401 is an employment: asking for it as a distinction, an education, or a qualification
    // finds the affiliation and then fails the type check, before visibility is considered.
    for (const kind of ["distinction", "education", "qualification", "service"]) {
      const reply = await getRecord(server, `/v3.0/${C}/${kind}/5401`);
      expect(reply.status).toBe(400);
      expect(reply.json).toEqual({
        "response-code": 400,
        "developer-message": `The client application sent a bad request to ORCID. Full validation error: Given affiliation 5401 doesn't match the desired type ${kind}`,
        "user-message": "The client application sent a bad request to ORCID.",
        "error-code": 9006,
        "more-info": "https://members.orcid.org/api/resources/troubleshooting",
      });
    }
    // Even a hidden affiliation: the type is checked first.
    const hidden = await getRecord(server, `/v3.0/${IDS.rich}/education/1503`);
    expect(hidden.status).toBe(400);
  });
});

const R = IDS.rich;
describe("a record with public, limited, and private affiliations shows only the public ones", () => {
  test("employments", async () => {
    const reply = await getRecord(server, `/v3.0/${R}/employments`);
    const groups = (reply.json as { "affiliation-group": Array<{ summaries: unknown[] }> })[
      "affiliation-group"
    ];
    expect(groups).toHaveLength(1);
    expect(groups[0]?.summaries).toEqual([
      {
        "employment-summary": {
          "created-date": stamp(),
          "last-modified-date": stamp(),
          source: source(R, "M. Quenby"),
          "put-code": 1501,
          "department-name": "Signals",
          "role-title": "Research Scientist",
          "start-date": date("2019", "09"),
          "end-date": null,
          organization: HARTWELL,
          url: { value: "https://example.test/hartwell" },
          "external-ids": null,
          "display-index": "0",
          visibility: "public",
          path: `/${R}/employment/1501`,
        },
      },
    ]);
  });

  test("educations: an affiliation's ids carry normalized values and make the group ids", async () => {
    const id = {
      "external-id-type": "grant_number",
      "external-id-value": "DEG-2016-01",
      "external-id-normalized": { value: "DEG-2016-01", transient: true },
      "external-id-normalized-error": null,
      "external-id-url": { value: "https://example.test/degrees/1" },
      "external-id-relationship": "self",
    };
    await expectBody(`/v3.0/${R}/educations`, {
      "last-modified-date": stamp(),
      "affiliation-group": [
        {
          "last-modified-date": stamp(),
          "external-ids": { "external-id": [id] },
          summaries: [
            {
              "education-summary": {
                "created-date": stamp(),
                "last-modified-date": stamp(),
                source: source(R, "M. Quenby"),
                "put-code": 1601,
                "department-name": "Department of Signals",
                "role-title": "Doctor of Philosophy",
                "start-date": date("2012", "02"),
                "end-date": date("2016", "12", "15"),
                organization: BROWNLOW,
                url: null,
                "external-ids": { "external-id": [id] },
                "display-index": "0",
                visibility: "public",
                path: `/${R}/education/1601`,
              },
            },
          ],
        },
      ],
      path: `/${R}/educations`,
    });
  });

  test("qualifications: a year-only start date and no end date", async () => {
    const reply = await getRecord(server, `/v3.0/${R}/qualifications`);
    const summary = (
      reply.json as {
        "affiliation-group": Array<{
          summaries: Array<{ "qualification-summary": Record<string, unknown> }>;
        }>;
      }
    )["affiliation-group"][0]?.summaries[0]?.["qualification-summary"];
    expect(summary?.["put-code"]).toBe(1701);
    expect(summary?.["start-date"]).toEqual(date("2021"));
    expect(summary?.["end-date"]).toBeNull();
    expect(summary?.["department-name"]).toBeNull();
    expect(summary?.path).toBe(`/${R}/qualification/1701`);
  });

  test("a record whose affiliations are all hidden has empty containers and null dates", async () => {
    for (const segment of ["employments", "educations", "qualifications"]) {
      await expectBody(`/v3.0/${IDS.allPrivate}/${segment}`, {
        "last-modified-date": null,
        "affiliation-group": [],
        path: `/${IDS.allPrivate}/${segment}`,
      });
    }
  });
});

describe("ordering and grouping", () => {
  const G = IDS.grouping;
  type Group = {
    "last-modified-date": unknown;
    "external-ids": { "external-id": Array<Record<string, unknown>> };
    summaries: Array<{ "employment-summary": { "put-code": number; "external-ids": unknown } }>;
  };
  const groupsOf = (reply: RecordReply): Group[] =>
    (reply.json as { "affiliation-group": Group[] })["affiliation-group"];

  test("undated first, then ongoing by latest start, then ended by latest end", async () => {
    const groups = groupsOf(await getRecord(server, `/v3.0/${G}/employments`));
    // 3103 and 3108 are undated (created-date ties keep the fixture's order), then 3104 (starts
    // 2018-06), the group of 3102 and 3101 (starts 2017-03 and 2015), 3106 (ended 2014-01),
    // and 3105 (ended 2012-05).
    expect(groups.map((g) => g.summaries.map((s) => s["employment-summary"]["put-code"]))).toEqual([
      [3103],
      [3108],
      [3104],
      [3102, 3101],
      [3106],
      [3105],
    ]);
  });

  test("items that share a groupable id form one group, the higher display index first", async () => {
    const groups = groupsOf(await getRecord(server, `/v3.0/${G}/employments`));
    const merged = groups[3];
    expect(merged?.["external-ids"]["external-id"]).toEqual([
      {
        "external-id-type": "grant_number",
        "external-id-value": "G-1",
        "external-id-normalized": { value: "G-1", transient: true },
        "external-id-normalized-error": null,
        "external-id-url": null,
        "external-id-relationship": "self",
      },
    ]);
    const indexes = merged?.summaries.map(
      (s) => (s["employment-summary"] as unknown as { "display-index": string })["display-index"],
    );
    expect(indexes).toEqual(["5", "0"]);
  });

  test("a funded-by id is not a group key, though the summary still lists it", async () => {
    const groups = groupsOf(await getRecord(server, `/v3.0/${G}/employments`));
    const group = groups[1];
    expect(group?.["external-ids"]["external-id"].map((id) => id["external-id-value"])).toEqual([
      "G-2",
    ]);
    const own = group?.summaries[0]?.["employment-summary"]["external-ids"] as {
      "external-id": Array<Record<string, unknown>>;
    };
    expect(own["external-id"].map((id) => id["external-id-value"])).toEqual(["G-2", "F-1"]);
  });

  test("grouping is among public items only: a hidden twin's other ids and group are gone", async () => {
    const text = (await getRecord(server, `/v3.0/${G}/employments`)).text;
    // 3107 shares G-2 with the public 3108 and also has G-3; 3109 and 3110 are a hidden group.
    expect(text).not.toContain("G-3");
    expect(text).not.toContain("G-9");
    expect(text).not.toContain('"put-code":3107');
    expect(text).not.toContain('"put-code":3109');
  });
});

describe("a single affiliation by put-code", () => {
  test("every kind serves its items", async () => {
    for (const [path, put] of [
      [`/v3.0/${R}/employment/1501`, 1501],
      [`/v3.0/${R}/education/1601`, 1601],
      [`/v3.0/${R}/qualification/1701`, 1701],
    ] as const) {
      const reply = await getRecord(server, path);
      expect(reply.status).toBe(200);
      expect((reply.json as { "put-code": number })["put-code"]).toBe(put);
    }
  });

  test("an unknown put-code and another record's are 404 / 9016", async () => {
    for (const path of [`/v3.0/${R}/employment/9999`, `/v3.0/${C}/employment/1501`]) {
      const reply = await getRecord(server, path);
      expect(reply.status).toBe(404);
      expect((reply.json as { "error-code": number })["error-code"]).toBe(9016);
    }
  });

  test("a limited or private item is 403 / 9039", async () => {
    for (const path of [
      `/v3.0/${R}/employment/1502`,
      `/v3.0/${R}/employment/1503`,
      `/v3.0/${R}/education/1602`,
      `/v3.0/${R}/qualification/1703`,
    ]) {
      const reply = await getRecord(server, path);
      expect(reply.status).toBe(403);
      expect((reply.json as { "error-code": number })["error-code"]).toBe(9039);
    }
  });

  test("a put-code that is not a number is 404 / 9001 (declared Long in the path), whatever the record's state", async () => {
    for (const orcid of [R, "0000-0000-0000-0000", IDS.deprecated, IDS.locked]) {
      const reply = await getRecord(server, `/v3.0/${orcid}/employment/abc`);
      expect([orcid, reply.status, (reply.json as { "error-code": number })["error-code"]]).toEqual(
        [orcid, 404, 9001],
      );
    }
  });

  test("a put-code that is not a number is 400 / 9006 for a qualification (converted in the method)", async () => {
    for (const orcid of [R, "0000-0000-0000-0000", IDS.deprecated, IDS.locked]) {
      const reply = await getRecord(server, `/v3.0/${orcid}/qualification/abc`);
      expect([orcid, reply.status, (reply.json as { "error-code": number })["error-code"]]).toEqual(
        [orcid, 400, 9006],
      );
    }
  });
});
