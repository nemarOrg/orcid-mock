// Fundings and peer reviews: summaries, grouping, ordering, and the full single-item reads.
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

async function expectBody(path: string, expected: unknown) {
  const reply = await getRecord(server, path);
  expect(reply.status).toBe(200);
  expect(reply.json).toEqual(expected);
  expect(reply.text).toBe(JSON.stringify(expected));
}

const FUNDER = {
  name: "Example Science Foundation",
  address: { city: "Auckland", region: null, country: "NZ" },
  "disambiguated-organization": {
    "disambiguated-organization-identifier": "https://ror.org/00funder000",
    "disambiguation-source": "ROR",
  },
};
const JOURNAL_BODY = {
  name: "Society of Imaginary Journals",
  address: { city: "London", region: "England", country: "GB" },
  "disambiguated-organization": null,
};

/** A funding id: no normalized value or error, whatever the type (observed). */
const fundingId = (value: string, relationship: string, url: string | null = null) => ({
  "external-id-type": "grant_number",
  "external-id-value": value,
  "external-id-normalized": null,
  "external-id-normalized-error": null,
  "external-id-url": url === null ? null : { value: url },
  "external-id-relationship": relationship,
});

const R = IDS.rich;
const G = IDS.grouping;

describe("fundings", () => {
  const grant1801 = fundingId("EXF-2020-001", "self", "https://example.test/grants/1");

  test("/fundings: a funding title has no subtitle, ids carry no normalized value, and visibility precedes put-code", async () => {
    await expectBody(`/v3.0/${R}/fundings`, {
      "last-modified-date": stamp(),
      group: [
        {
          "last-modified-date": stamp(),
          "external-ids": { "external-id": [grant1801] },
          "funding-summary": [
            {
              "created-date": stamp(),
              "last-modified-date": stamp(),
              source: source(R, "M. Quenby"),
              title: {
                title: { value: "Fictional Signals Initiative" },
                "translated-title": {
                  value: "Initiative des signaux fictifs",
                  "language-code": "fr",
                },
              },
              "external-ids": { "external-id": [grant1801] },
              url: { value: "https://example.test/initiative" },
              type: "grant",
              "start-date": { year: { value: "2020" }, month: { value: "01" }, day: null },
              "end-date": { year: { value: "2023" }, month: { value: "12" }, day: null },
              organization: FUNDER,
              visibility: "public",
              "put-code": 1801,
              path: `/${R}/funding/1801`,
              "display-index": "1",
            },
          ],
        },
      ],
      path: `/${R}/fundings`,
    });
  });

  test("/funding/{put-code}: seventeen keys, null for what a fixture lacks, no display-index", async () => {
    await expectBody(`/v3.0/${R}/funding/1801`, {
      "created-date": stamp(),
      "last-modified-date": stamp(),
      source: source(R, "M. Quenby"),
      "put-code": 1801,
      path: `/${R}/funding/1801`,
      type: "grant",
      "organization-defined-type": null,
      title: {
        title: { value: "Fictional Signals Initiative" },
        "translated-title": { value: "Initiative des signaux fictifs", "language-code": "fr" },
      },
      "short-description": null,
      amount: null,
      url: { value: "https://example.test/initiative" },
      "start-date": { year: { value: "2020" }, month: { value: "01" }, day: null },
      "end-date": { year: { value: "2023" }, month: { value: "12" }, day: null },
      "external-ids": { "external-id": [grant1801] },
      contributors: null,
      organization: FUNDER,
      visibility: "public",
    });
  });

  test("a record with only hidden fundings has an empty container and a null date", async () => {
    await expectBody(`/v3.0/${IDS.allPrivate}/fundings`, {
      "last-modified-date": null,
      group: [],
      path: `/${IDS.allPrivate}/fundings`,
    });
  });

  test("an unknown put-code is 404 / 9016, a hidden one 403 / 9039, a non-number 404 / 9001", async () => {
    const cases: Array<[string, number, number]> = [
      [`/v3.0/${R}/funding/9999`, 404, 9016],
      [`/v3.0/${R}/funding/1802`, 403, 9039],
      [`/v3.0/${R}/funding/1803`, 403, 9039],
      [`/v3.0/${G}/funding/1801`, 404, 9016],
      [`/v3.0/${R}/funding/abc`, 404, 9001],
    ];
    for (const [path, status, code] of cases) {
      const reply = await getRecord(server, path);
      expect(reply.status).toBe(status);
      expect((reply.json as { "error-code": number })["error-code"]).toBe(code);
    }
  });

  describe("ordering and grouping", () => {
    type Group = {
      "external-ids": { "external-id": Array<Record<string, unknown>> };
      "funding-summary": Array<{ "put-code": number; "external-ids": unknown }>;
    };
    const groups = async () =>
      ((await getRecord(server, `/v3.0/${G}/fundings`)).json as { group: Group[] }).group;

    test("groups follow the database's order, display index then creation, and members the display index", async () => {
      // 3302 (3), 3303 (1), 3304 (1), 3301 (0); the hidden 3305 (9) is filtered first, and 3301
      // joins the group 3302 formed.
      expect((await groups()).map((g) => g["funding-summary"].map((f) => f["put-code"]))).toEqual([
        [3302, 3301],
        [3303],
        [3304],
      ]);
    });

    test("a funded-by id is not a key, and a hidden funding's id joins nothing", async () => {
      const all = await groups();
      expect(all[0]?.["external-ids"]["external-id"]).toEqual([fundingId("GR-1", "self")]);
      expect(all[1]?.["external-ids"]).toEqual({ "external-id": [] });
      expect(all[2]?.["external-ids"]["external-id"]).toEqual([fundingId("GR-3", "self")]);
      // The summary still lists every id it has, the funded-by one included.
      const own = all[2]?.["funding-summary"][0]?.["external-ids"] as {
        "external-id": unknown[];
      };
      expect(own["external-id"]).toHaveLength(2);
    });
  });
});

describe("peer reviews", () => {
  const C = IDS.carberry;
  const workId = (value: string) => ({
    "external-id-type": "source-work-id",
    "external-id-value": value,
    "external-id-normalized": { value, transient: true },
    "external-id-normalized-error": null,
    "external-id-url": null,
    "external-id-relationship": "self",
  });
  const groupKey = (value: string) => ({
    "external-id-type": "peer-review",
    "external-id-value": value,
    "external-id-normalized": null,
    "external-id-normalized-error": null,
    "external-id-url": null,
    "external-id-relationship": null,
  });

  test("/peer-reviews has three levels, each with a date, and the group id as a peer-review id", async () => {
    await expectBody(`/v3.0/${C}/peer-reviews`, {
      "last-modified-date": stamp(),
      group: [
        {
          "last-modified-date": stamp(),
          "external-ids": { "external-id": [groupKey("issn:0000-0001")] },
          "peer-review-group": [
            {
              "last-modified-date": stamp(),
              "external-ids": { "external-id": [workId("10001")] },
              "peer-review-summary": [
                {
                  "created-date": stamp(),
                  "last-modified-date": stamp(),
                  source: source(C, "Josiah Carberry"),
                  "reviewer-role": "reviewer",
                  "external-ids": { "external-id": [workId("10001")] },
                  "review-url": null,
                  "review-type": "review",
                  "completion-date": {
                    year: { value: "2004" },
                    month: { value: "02" },
                    day: { value: "02" },
                  },
                  "review-group-id": "issn:0000-0001",
                  "convening-organization": JOURNAL_BODY,
                  visibility: "public",
                  "put-code": 5601,
                  path: `/${C}/peer-review/5601`,
                  "display-index": "0",
                },
              ],
            },
          ],
        },
      ],
      path: `/${C}/peer-reviews`,
    });
  });

  test("/peer-review/{put-code} names the ids and the date differently, and has subject keys", async () => {
    await expectBody(`/v3.0/${R}/peer-review/1901`, {
      "created-date": stamp(),
      "last-modified-date": stamp(),
      source: source(R, "M. Quenby"),
      "reviewer-role": "reviewer",
      "review-identifiers": { "external-id": [workId("20001")] },
      "review-url": { value: "https://example.test/reviews/1" },
      "review-type": "review",
      "review-completion-date": {
        year: { value: "2023" },
        month: { value: "06" },
        day: { value: "01" },
      },
      "review-group-id": "issn:0000-0002",
      "subject-external-identifier": null,
      "subject-container-name": null,
      "subject-type": null,
      "subject-name": null,
      "subject-url": null,
      "convening-organization": JOURNAL_BODY,
      visibility: "public",
      "put-code": 1901,
      path: `/${R}/peer-review/1901`,
    });
  });

  test("a record with public, limited, and private reviews shows only the public one", async () => {
    const reply = await getRecord(server, `/v3.0/${R}/peer-reviews`);
    expect(reply.text).toContain('"put-code":1901');
    expect(reply.text).not.toContain('"put-code":1902');
    expect(reply.text).not.toContain('"put-code":1903');
    expect(reply.text).not.toContain("issn:0000-0003");
  });

  test("a record with only hidden reviews has an empty container and a null date", async () => {
    await expectBody(`/v3.0/${IDS.allPrivate}/peer-reviews`, {
      "last-modified-date": null,
      group: [],
      path: `/${IDS.allPrivate}/peer-reviews`,
    });
  });

  test("an unknown put-code is 404 / 9016, a hidden one 403 / 9039, a non-number 404 / 9001", async () => {
    const cases: Array<[string, number, number]> = [
      [`/v3.0/${R}/peer-review/9999`, 404, 9016],
      [`/v3.0/${R}/peer-review/1902`, 403, 9039],
      [`/v3.0/${R}/peer-review/1903`, 403, 9039],
      [`/v3.0/${R}/peer-review/abc`, 404, 9001],
    ];
    for (const [path, status, code] of cases) {
      const reply = await getRecord(server, path);
      expect(reply.status).toBe(status);
      expect((reply.json as { "error-code": number })["error-code"]).toBe(code);
    }
  });

  describe("ordering and grouping", () => {
    type Inner = { "peer-review-summary": Array<{ "put-code": number }> };
    type Outer = {
      "external-ids": { "external-id": Array<{ "external-id-value": string }> };
      "peer-review-group": Inner[];
    };
    const outer = async (): Promise<Outer[]> =>
      (
        (await getRecord(server, `/v3.0/${G}/peer-reviews`)) as RecordReply & {
          json: { group: Outer[] };
        }
      ).json.group;

    test("outer groups by review-group id, newest completion first; inner groups by shared id", async () => {
      // Sorted by completion date, newest first: 3404, 3401, 3402, 3403, then 3405 (no date).
      const groups = await outer();
      expect(groups.map((g) => g["external-ids"]["external-id"][0]?.["external-id-value"])).toEqual(
        ["issn:2222-2222", "issn:1111-1111", "issn:3333-3333"],
      );
      expect(
        groups.map((g) =>
          g["peer-review-group"].map((i) => i["peer-review-summary"].map((s) => s["put-code"])),
        ),
      ).toEqual([[[3404]], [[3401, 3402], [3403]], [[3405]]]);
    });

    test("a hidden review's whole group is gone", async () => {
      const text = (await getRecord(server, `/v3.0/${G}/peer-reviews`)).text;
      expect(text).not.toContain("issn:4444-4444");
      expect(text).not.toContain('"put-code":3406');
    });
  });
});
