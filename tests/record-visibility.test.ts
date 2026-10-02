// What each reader sees: the public view, and the limited view of a member client's
// `/read-limited` token for the record's own iD. `private` is never served.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { IDS, RECORD_USERS_FILE } from "./fixtures/record";
import { startTestServer, type TestServer } from "./harness";
import { obtainToken } from "./helpers/oauth";
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
const limitedToken = async (orcid: string): Promise<string> =>
  (await obtainToken(server, { orcid, scope: "/read-limited", client: "member" })).access_token;

const R = IDS.rich;
type Items = Record<string, Array<{ "put-code": number; visibility: string }>>;

/** The put-codes a section lists, in order. */
const putCodes = (reply: RecordReply, key: string): number[] =>
  ((reply.json as Items)[key] ?? []).map((item) => item["put-code"]);

describe("person-level sections, anonymous and limited", () => {
  const lists: Array<[string, string, number[], number[]]> = [
    ["other-names", "other-name", [1001], [1001, 1002]],
    ["address", "address", [1101], [1101, 1102]],
    ["keywords", "keyword", [1201], [1201, 1202]],
    ["external-identifiers", "external-identifier", [1301], [1301, 1302]],
    ["researcher-urls", "researcher-url", [1401], [1401, 1402]],
  ];
  for (const [segment, key, anonymous, limited] of lists) {
    test(`/${segment}: public items, then public and limited, never private`, async () => {
      const token = await limitedToken(R);
      expect(putCodes(await getRecord(server, `/v3.0/${R}/${segment}`), key)).toEqual(anonymous);
      const asOwner = await getRecord(server, `/v3.0/${R}/${segment}`, { token });
      expect(putCodes(asOwner, key)).toEqual(limited);
      expect((asOwner.json as { "last-modified-date": unknown })["last-modified-date"]).toEqual(
        stamp(),
      );
    });
  }

  test("/email: the limited reader sees the limited email too, with its put-code still null", async () => {
    const token = await limitedToken(R);
    const reply = await getRecord(server, `/v3.0/${R}/email`, { token });
    const emails = (reply.json as { email: Array<Record<string, unknown>> }).email;
    expect(emails.map((e) => [e.email, e.visibility, e["put-code"]])).toEqual([
      ["marisol.quenby@example.test", "public", null],
      ["marisol.limited@example.test", "limited", null],
    ]);
    expect(reply.text).not.toContain("marisol.private@example.test");
  });

  test("a limited name and biography are null to the public and shown to a limited reader", async () => {
    const O = IDS.limitedName;
    const anonymous = await getRecord(server, `/v3.0/${O}/personal-details`);
    const body = anonymous.json as Record<string, unknown>;
    expect(body.name).toBeNull();
    expect(body.biography).toBeNull();
    expect(body["last-modified-date"]).toBeNull();
    expect((await getRecord(server, `/v3.0/${O}/biography`)).status).toBe(403);

    const token = await limitedToken(O);
    const owner = await getRecord(server, `/v3.0/${O}/personal-details`, { token });
    const shown = owner.json as { name: { "given-names": { value: string } }; biography: unknown };
    expect(shown.name["given-names"].value).toBe("Isolde");
    expect(shown.biography).not.toBeNull();
    expect((owner.json as Record<string, unknown>)["last-modified-date"]).toEqual(stamp());
    expect((await getRecord(server, `/v3.0/${O}/biography`, { token })).status).toBe(200);
  });

  test("a private name stays null for the owner's own limited token", async () => {
    const token = await limitedToken(IDS.privateName);
    const reply = await getRecord(server, `/v3.0/${IDS.privateName}/personal-details`, { token });
    expect((reply.json as { name: unknown }).name).toBeNull();
    // And a private biography stays hidden.
    const bio = await getRecord(server, `/v3.0/${IDS.bioPrivate}/biography`, {
      token: await limitedToken(IDS.bioPrivate),
    });
    expect(bio.status).toBe(403);
  });
});

describe("activities, anonymous and limited", () => {
  /** The put-code of a summary, whether it is bare (works, fundings) or wrapped (affiliations). */
  const codeOf = (entry: Record<string, unknown>): number =>
    typeof entry["put-code"] === "number"
      ? entry["put-code"]
      : ((Object.values(entry)[0] as Record<string, unknown>)["put-code"] as number);
  const groupCodes = (reply: RecordReply, key: string, summaries: string): number[][] =>
    ((reply.json as Record<string, Array<Record<string, unknown>>>)[key] ?? []).map((group) =>
      (group[summaries] as Array<Record<string, unknown>>).map(codeOf),
    );

  test("employments, educations, and qualifications", async () => {
    const token = await limitedToken(R);
    const cases: Array<[string, number[][], number[][]]> = [
      ["employments", [[1501]], [[1501], [1502]]],
      ["educations", [[1601]], [[1601], [1602]]],
      // 1702 has no dates and so sorts first (`Z-`), ahead of 1701 (`Y-2021`).
      ["qualifications", [[1701]], [[1702], [1701]]],
    ];
    for (const [segment, anonymous, limited] of cases) {
      const a = await getRecord(server, `/v3.0/${R}/${segment}`);
      const l = await getRecord(server, `/v3.0/${R}/${segment}`, { token });
      expect(groupCodes(a, "affiliation-group", "summaries")).toEqual(anonymous);
      expect(groupCodes(l, "affiliation-group", "summaries")).toEqual(limited);
    }
  });

  test("fundings, works, and peer reviews", async () => {
    const token = await limitedToken(R);
    const fundingsAnonymous = await getRecord(server, `/v3.0/${R}/fundings`);
    const fundingsLimited = await getRecord(server, `/v3.0/${R}/fundings`, { token });
    expect(groupCodes(fundingsAnonymous, "group", "funding-summary")).toEqual([[1801]]);
    expect(groupCodes(fundingsLimited, "group", "funding-summary")).toEqual([[1801], [1802]]);

    const worksAnonymous = await getRecord(server, `/v3.0/${R}/works`);
    const worksLimited = await getRecord(server, `/v3.0/${R}/works`, { token });
    expect(groupCodes(worksAnonymous, "group", "work-summary")).toEqual([[2001]]);
    expect(groupCodes(worksLimited, "group", "work-summary")).toEqual([[2001], [2002]]);

    const reviews = await getRecord(server, `/v3.0/${R}/peer-reviews`, { token });
    expect(reviews.text).toContain('"put-code":1902');
    expect(reviews.text).not.toContain('"put-code":1903');
  });

  test("a limited reader of a record with only hidden items sees the limited ones, and still no private ones", async () => {
    const A = IDS.allPrivate;
    const token = await limitedToken(A);
    const record = await getRecord(server, `/v3.0/${A}/record`, { token });
    const text = record.text;
    // Limited: an email, an address, an external identifier, an education, a review.
    for (const shown of [
      '"put-code":4002',
      '"put-code":4004',
      '"put-code":4102',
      '"put-code":4301',
    ]) {
      expect(text).toContain(shown);
    }
    expect(text).toContain("ghost.reader@example.test");
    // Private: an other name, a keyword, a researcher URL, an employment, a qualification, a
    // funding, a work.
    for (const hidden of [
      '"put-code":4001',
      '"put-code":4003',
      '"put-code":4005',
      '"put-code":4101',
      '"put-code":4103',
      '"put-code":4201',
      '"put-code":4401',
    ]) {
      expect(text).not.toContain(hidden);
    }
    const body = record.json as {
      person: { "last-modified-date": unknown };
      "activities-summary": { "last-modified-date": unknown; works: unknown; fundings: unknown };
    };
    expect(body.person["last-modified-date"]).toEqual(stamp());
    expect(body["activities-summary"]["last-modified-date"]).toEqual(stamp());
    // The works and fundings are all private, so their dates are still null.
    expect(
      (body["activities-summary"].works as { "last-modified-date": unknown })["last-modified-date"],
    ).toBeNull();
    expect(
      (body["activities-summary"].fundings as { "last-modified-date": unknown })[
        "last-modified-date"
      ],
    ).toBeNull();
  });
});

describe("single items for a limited reader", () => {
  test("a limited item is 200, a private one is still 403 / 9039", async () => {
    const token = await limitedToken(R);
    for (const [path, status] of [
      [`/v3.0/${R}/other-names/1002`, 200],
      [`/v3.0/${R}/other-names/1003`, 403],
      [`/v3.0/${R}/employment/1502`, 200],
      [`/v3.0/${R}/employment/1503`, 403],
      [`/v3.0/${R}/education/1602`, 200],
      [`/v3.0/${R}/qualification/1703`, 403],
      [`/v3.0/${R}/funding/1802`, 200],
      [`/v3.0/${R}/funding/1803`, 403],
      [`/v3.0/${R}/peer-review/1902`, 200],
      [`/v3.0/${R}/peer-review/1903`, 403],
      [`/v3.0/${R}/work/2002`, 200],
      [`/v3.0/${R}/work/2003`, 403],
    ] as const) {
      expect((await getRecord(server, path, { token })).status).toBe(status);
    }
  });

  test("the same items are all 403 / 9039 to the public", async () => {
    for (const path of [
      `/v3.0/${R}/other-names/1002`,
      `/v3.0/${R}/employment/1502`,
      `/v3.0/${R}/funding/1802`,
      `/v3.0/${R}/peer-review/1902`,
      `/v3.0/${R}/work/2002`,
    ]) {
      const reply = await getRecord(server, path);
      expect(reply.status).toBe(403);
      expect((reply.json as { "error-code": number })["error-code"]).toBe(9039);
    }
  });

  test("bulk works: a limited reader gets the limited work, the private one is a 9039 element", async () => {
    const token = await limitedToken(R);
    const reply = await getRecord(server, `/v3.0/${R}/works/2001,2002,2003`, { token });
    const kinds = (
      reply.json as { bulk: Array<Record<string, { "error-code"?: number }>> }
    ).bulk.map((element) => Object.keys(element)[0]);
    expect(kinds).toEqual(["work", "work", "error"]);
  });
});

describe("the same token on another record is the public view", () => {
  test("/record of another iD shows no limited item", async () => {
    const token = await limitedToken(R);
    const own = await getRecord(server, `/v3.0/${IDS.allPrivate}/record`, { token });
    expect(own.text).not.toContain("ghost.reader@example.test");
    expect(own.text).not.toContain('"put-code":4002');
    // The all-private record's own token would see them (above); this token is Marisol's.
  });

  test("a token for another user's iD does not open a limited name", async () => {
    const token = await limitedToken(R);
    const reply = await getRecord(server, `/v3.0/${IDS.limitedName}/personal-details`, { token });
    expect((reply.json as { name: unknown }).name).toBeNull();
  });
});
