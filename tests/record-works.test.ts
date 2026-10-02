// Works: the grouped summaries, one full work, and the bulk read.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { IDS, RECORD_USERS_FILE } from "./fixtures/record";
import { startTestServer, type TestServer } from "./harness";
import { obtainToken } from "./helpers/oauth";
import { ERROR_KEYS, getRecord, loadStamp, type RecordReply } from "./helpers/record";

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
const source = (orcid: string, name: string) => ({
  "source-orcid": { uri: `${server.publicBaseUrl}/${orcid}`, path: orcid, host: host() },
  "source-client-id": null,
  "source-name": { value: name },
  "assertion-origin-orcid": null,
  "assertion-origin-client-id": null,
  "assertion-origin-name": null,
});

/** An id as a work writes it: six keys, with a normalized value and no error. */
const extId = (
  type: string,
  value: string,
  relationship: string | null,
  normalized: string | null = value,
  url: string | null = null,
) => ({
  "external-id-type": type,
  "external-id-value": value,
  "external-id-normalized": normalized === null ? null : { value: normalized, transient: true },
  "external-id-normalized-error": null,
  "external-id-url": url === null ? null : { value: url },
  "external-id-relationship": relationship,
});

async function expectBody(path: string, expected: unknown) {
  const reply = await getRecord(server, path);
  expect(reply.status).toBe(200);
  expect(reply.json).toEqual(expected);
  expect(reply.text).toBe(JSON.stringify(expected));
}

const C = IDS.carberry;
const summary = (put: number, display: string, fields: object) => ({
  "put-code": put,
  "created-date": stamp(),
  "last-modified-date": stamp(),
  source: source(C, "Josiah Carberry"),
  ...fields,
  visibility: "public",
  path: `/${C}/work/${put}`,
  "display-index": display,
});

describe("Josiah Carberry's works", () => {
  /** The keys of a summary between `source` and `visibility`, in ORCID's order. */
  const fields = (f: {
    title: object;
    ids: unknown[];
    url?: string;
    publication: object;
    journal?: string;
  }) => ({
    title: f.title,
    "external-ids": { "external-id": f.ids },
    url: f.url === undefined ? null : { value: f.url },
    type: "journal-article",
    "publication-date": f.publication,
    "journal-title": f.journal === undefined ? null : { value: f.journal },
  });
  const title = (value: string, subtitle?: string) => ({
    title: { value },
    subtitle: subtitle === undefined ? null : { value: subtitle },
    "translated-title": null,
  });
  const GLAZED = "On the Fracture Mechanics of Glazed Vessels";
  const doi1 = extId("doi", "10.5555/carberry.0001", "self");

  test("two groups, newest first; the shared-DOI group holds both works, higher display index first", async () => {
    await expectBody(`/v3.0/${C}/works`, {
      "last-modified-date": stamp(),
      group: [
        {
          "last-modified-date": stamp(),
          // Only the groupable id: the part-of ISSN is not a key.
          "external-ids": { "external-id": [doi1] },
          "work-summary": [
            summary(
              5501,
              "2",
              fields({
                title: title(GLAZED, "A pilot study"),
                ids: [extId("issn", "0000-0001", "part-of"), doi1],
                publication: { year: { value: "2012" }, month: null, day: null },
                journal: "Journal of Imaginary Ceramics",
              }),
            ),
            summary(
              5502,
              "1",
              fields({
                title: title(GLAZED),
                ids: [doi1],
                publication: { year: { value: "2012" }, month: null, day: null },
              }),
            ),
          ],
        },
        {
          "last-modified-date": stamp(),
          "external-ids": {
            "external-id": [
              extId("doi", "10.5555/carberry.0002", "self"),
              extId("eid", "2-s2.0-0000000001", "self"),
            ],
          },
          "work-summary": [
            summary(
              5503,
              "0",
              fields({
                title: title("Plasmons in Layered Earthenware"),
                ids: [
                  extId("doi", "10.5555/carberry.0002", "self"),
                  extId("eid", "2-s2.0-0000000001", "self"),
                ],
                url: "https://example.test/works/plasmons",
                publication: { year: { value: "1987" }, month: null, day: null },
                journal: "Proceedings of Imaginary Physics",
              }),
            ),
          ],
        },
      ],
      path: `/${C}/works`,
    });
  });

  test("a work with a full date and a work with none are summarized without the detail keys", async () => {
    const reply = await getRecord(server, `/v3.0/${IDS.rich}/works`);
    const group = (
      reply.json as { group: Array<{ "work-summary": Array<Record<string, unknown>> }> }
    ).group[0];
    expect(Object.keys(group?.["work-summary"][0] ?? {})).toEqual([
      "put-code",
      "created-date",
      "last-modified-date",
      "source",
      "title",
      "external-ids",
      "url",
      "type",
      "publication-date",
      "journal-title",
      "visibility",
      "path",
      "display-index",
    ]);
    expect(group?.["work-summary"][0]?.["publication-date"]).toEqual({
      year: { value: "2022" },
      month: { value: "03" },
      day: { value: "14" },
    });
    expect(group?.["work-summary"][0]?.title).toEqual({
      title: { value: "Signals in Imaginary Noise" },
      subtitle: { value: "A reappraisal" },
      "translated-title": { value: "Signaux dans le bruit imaginaire", "language-code": "fr" },
    });
  });
});

const R = IDS.rich;
describe("the full work", () => {
  test("seventeen keys, put-code and path after source, citation, contributors, and visibility last", async () => {
    await expectBody(`/v3.0/${R}/work/2001`, {
      "created-date": stamp(),
      "last-modified-date": stamp(),
      source: source(R, "M. Quenby"),
      "put-code": 2001,
      path: `/${R}/work/2001`,
      title: {
        title: { value: "Signals in Imaginary Noise" },
        subtitle: { value: "A reappraisal" },
        "translated-title": { value: "Signaux dans le bruit imaginaire", "language-code": "fr" },
      },
      "journal-title": { value: "Journal of Imaginary Neuroscience" },
      "short-description": "A public article.",
      citation: {
        "citation-type": "bibtex",
        "citation-value": "@article{quenby2022, title={Signals}}",
      },
      type: "journal-article",
      "publication-date": { year: { value: "2022" }, month: { value: "03" }, day: { value: "14" } },
      "external-ids": { "external-id": [extId("doi", "10.5555/rich.0001", "self")] },
      url: { value: "https://doi.org/10.5555/rich.0001" },
      contributors: {
        contributor: [
          {
            "contributor-orcid": null,
            "credit-name": { value: "Marisol Quenby" },
            "contributor-email": null,
            "contributor-attributes": {
              "contributor-sequence": "first",
              "contributor-role": "author",
            },
          },
          {
            "contributor-orcid": {
              uri: `${server.publicBaseUrl}/${IDS.carberry}`,
              path: IDS.carberry,
              host: host(),
            },
            "credit-name": { value: "Josiah Carberry" },
            "contributor-email": null,
            "contributor-attributes": {
              "contributor-sequence": "additional",
              "contributor-role": "author",
            },
          },
          {
            "contributor-orcid": null,
            "credit-name": { value: "A. Collaborator" },
            "contributor-email": null,
            "contributor-attributes": null,
          },
        ],
      },
      "language-code": "en",
      country: { value: "NZ" },
      visibility: "public",
    });
  });

  test("every optional part is null when absent, and the work has no display-index", async () => {
    const reply = await getRecord(server, `/v3.0/${C}/work/5502`);
    const body = reply.json as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([
      "created-date",
      "last-modified-date",
      "source",
      "put-code",
      "path",
      "title",
      "journal-title",
      "short-description",
      "citation",
      "type",
      "publication-date",
      "external-ids",
      "url",
      "contributors",
      "language-code",
      "country",
      "visibility",
    ]);
    for (const key of [
      "journal-title",
      "short-description",
      "citation",
      "url",
      "contributors",
      "language-code",
      "country",
    ]) {
      expect(body[key]).toBeNull();
    }
  });

  test("an unknown put-code, another record's, and an employment's are 404 / 9016", async () => {
    for (const path of [`/v3.0/${R}/work/9999`, `/v3.0/${C}/work/2001`, `/v3.0/${R}/work/1501`]) {
      const reply = await getRecord(server, path);
      expect(reply.status).toBe(404);
      expect((reply.json as { "error-code": number })["error-code"]).toBe(9016);
    }
  });

  test("a limited or private work is 403 / 9039", async () => {
    for (const put of [2002, 2003]) {
      const reply = await getRecord(server, `/v3.0/${R}/work/${put}`);
      expect(reply.status).toBe(403);
      expect((reply.json as { "error-code": number })["error-code"]).toBe(9039);
    }
  });

  test("a put-code that is not a number is 404 / 9001 with the NumberFormatException", async () => {
    const reply = await getRecord(server, `/v3.0/${R}/work/abc`);
    expect(reply.status).toBe(404);
    expect(String((reply.json as { "developer-message": string })["developer-message"])).toEndWith(
      'Full validation error: HTTP 404 Not Found (java.lang.NumberFormatException: For input string: "abc")',
    );
  });
});

describe("a record with public, limited, and private works shows only the public one", () => {
  test("/works", async () => {
    const reply = await getRecord(server, `/v3.0/${R}/works`);
    const body = reply.json as { group: Array<{ "work-summary": Array<{ "put-code": number }> }> };
    expect(body.group.map((g) => g["work-summary"].map((w) => w["put-code"]))).toEqual([[2001]]);
    expect(reply.text).not.toContain("rich.0002");
    expect(reply.text).not.toContain("rich.0003");
  });

  test("a record with only hidden works has an empty container and a null date", async () => {
    await expectBody(`/v3.0/${IDS.allPrivate}/works`, {
      "last-modified-date": null,
      group: [],
      path: `/${IDS.allPrivate}/works`,
    });
  });
});

describe("grouping and ordering of works", () => {
  const G = IDS.grouping;
  type Group = {
    "last-modified-date": unknown;
    "external-ids": { "external-id": Array<Record<string, unknown>> };
    "work-summary": Array<{ "put-code": number }>;
  };
  const groupsOf = (reply: RecordReply): Group[] => (reply.json as { group: Group[] }).group;
  const codes = (groups: Group[]) => groups.map((g) => g["work-summary"].map((w) => w["put-code"]));

  test("groups are ordered by date newest first, then title, then type", async () => {
    // 3201+3202 2022-03-14; 3215 2022-03; 3216 2022; 3204 2021-10; 3203 2020; 3205-3207 2019;
    // 3208+3209 2018; 3210 2017; 3213 2016; 3218 (book) and 3217 (report) 2015; 3220 and 3219
    // 2014 by title; 3222+3223 2013; 3224 2012; 3221 with no date last. 3211+3212 are hidden and
    // 3214 joins no group.
    expect(codes(groupsOf(await getRecord(server, `/v3.0/${G}/works`)))).toEqual([
      [3201, 3202],
      [3215],
      [3216],
      [3204],
      [3203],
      [3205, 3206, 3207],
      [3208, 3209],
      [3210],
      [3213],
      [3218],
      [3217],
      [3220],
      [3219],
      [3222, 3223],
      [3224],
      [3221],
    ]);
  });

  test("DOIs that differ only in case are one key; the group keeps the first spelling, normalized lowercase", async () => {
    const group = groupsOf(await getRecord(server, `/v3.0/${G}/works`))[0];
    expect(group?.["external-ids"]["external-id"]).toEqual([
      extId("doi", "10.5555/GROUP.A", "self", "10.5555/group.a"),
    ]);
    // The higher display index is the preferred summary, the first.
    expect(group?.["work-summary"].map((w) => w["put-code"])).toEqual([3201, 3202]);
  });

  test("a part-of id is not a group key, so works that share only an ISSN stay apart", async () => {
    const groups = groupsOf(await getRecord(server, `/v3.0/${G}/works`));
    const beta = groups.find((g) => g["work-summary"][0]?.["put-code"] === 3203);
    expect(beta?.["external-ids"]).toEqual({ "external-id": [] });
    const gamma = groups.find((g) => g["work-summary"][0]?.["put-code"] === 3204);
    expect(gamma?.["external-ids"]).toEqual({ "external-id": [] });
  });

  test("a work that bridges two groups merges them, and the keys are the union", async () => {
    const group = groupsOf(await getRecord(server, `/v3.0/${G}/works`))[5];
    expect(group?.["work-summary"].map((w) => w["put-code"])).toEqual([3205, 3206, 3207]);
    expect(group?.["external-ids"]["external-id"].map((id) => id["external-id-value"])).toEqual([
      "10.5555/t.x",
      "10.5555/t.y",
    ]);
  });

  test("version-of ids group, as ORCID's rule only excludes part-of and funded-by", async () => {
    const group = groupsOf(await getRecord(server, `/v3.0/${G}/works`))[6];
    expect(group?.["work-summary"].map((w) => w["put-code"])).toEqual([3208, 3209]);
    expect(group?.["external-ids"]["external-id"]).toEqual([
      extId("doi", "10.5555/v.1", "version-of"),
    ]);
  });

  test("a DOI is normalized as ORCID's normalizer does: the URL prefix goes, the case folds, and a bad one fails with 8001", async () => {
    const groups = groupsOf(await getRecord(server, `/v3.0/${G}/works`));
    const prefixed = groups.find((g) => g["work-summary"][0]?.["put-code"] === 3222);
    // One group of two; the key is the first spelling, with the normalized value beside it.
    expect(prefixed?.["work-summary"].map((w) => w["put-code"])).toEqual([3222, 3223]);
    expect(prefixed?.["external-ids"]["external-id"]).toEqual([
      extId("doi", "https://doi.org/10.5555/URL.Prefix", "self", "10.5555/url.prefix"),
    ]);

    const bad = groups.find((g) => g["work-summary"][0]?.["put-code"] === 3224);
    expect(bad?.["external-ids"]["external-id"]).toEqual([
      {
        "external-id-type": "doi",
        "external-id-value": "work:doi",
        "external-id-normalized": null,
        "external-id-normalized-error": {
          "error-code": "8001",
          "error-message": "Cannot normalize identifier value doi:work:doi",
          transient: true,
        },
        "external-id-url": null,
        "external-id-relationship": "self",
      },
    ]);
  });

  test("a work with no ids is a group of its own with an empty id list", async () => {
    const group = groupsOf(await getRecord(server, `/v3.0/${G}/works`))[7];
    expect(group?.["work-summary"].map((w) => w["put-code"])).toEqual([3210]);
    expect(group?.["external-ids"]).toEqual({ "external-id": [] });
  });

  test("grouping is among visible works: a hidden twin adds no key and no group", async () => {
    const reply = await getRecord(server, `/v3.0/${G}/works`);
    const group = groupsOf(reply)[8];
    expect(group?.["work-summary"].map((w) => w["put-code"])).toEqual([3213]);
    expect(group?.["external-ids"]["external-id"].map((id) => id["external-id-type"])).toEqual([
      "doi",
    ]);
    expect(reply.text).not.toContain("E-LEAK");
    expect(reply.text).not.toContain("10.5555/hid");
    expect(reply.text).not.toContain("Eta hidden");
  });
});

describe("the bulk read", () => {
  const body = (reply: RecordReply) =>
    (reply.json as { bulk: Array<Record<string, Record<string, unknown>>> }).bulk;
  const kinds = (reply: RecordReply) =>
    body(reply).map((element) => {
      const [key] = Object.keys(element);
      const value = element[key as string] as Record<string, unknown>;
      return key === "work" ? `work:${value["put-code"]}` : `error:${value["error-code"]}`;
    });

  const PATH = `/v3.0/${C}/works`;

  test("each work is the full work, wrapped in one key", async () => {
    const reply = await getRecord(server, `${PATH}/5501,5503`);
    expect(reply.status).toBe(200);
    expect(Object.keys(reply.json as object)).toEqual(["bulk"]);
    const single = (await getRecord(server, `${PATH.replace("works", "work")}/5501`)).json;
    expect(body(reply)[0]).toEqual({ work: single as Record<string, unknown> });
    expect(kinds(reply)).toEqual(["work:5501", "work:5503"]);
  });

  test("works come back in put-code order, not request order (observed)", async () => {
    expect(kinds(await getRecord(server, `${PATH}/5503,5501`))).toEqual(["work:5501", "work:5503"]);
  });

  test("a put-code that is unknown, another record's, or repeated is a 9034 element after the works", async () => {
    const reply = await getRecord(server, `${PATH}/5503,1,5501,5501,2001`);
    expect(reply.status).toBe(200);
    expect(kinds(reply)).toEqual([
      "work:5501",
      "work:5503",
      "error:9034",
      "error:9034",
      "error:9034",
    ]);
    const errors = body(reply)
      .slice(2)
      .map((element) => element.error);
    // Request order among the errors; the element ORCID prints is the number it parsed.
    expect(errors.map((e) => e?.["developer-message"])).toEqual([
      "400 Bad Request: The put code provided is not valid. Full validation error: '1' is not a valid put code",
      "400 Bad Request: The put code provided is not valid. Full validation error: '5501' is not a valid put code",
      "400 Bad Request: The put code provided is not valid. Full validation error: '2001' is not a valid put code",
    ]);
  });

  test("an error element has the five keys, and the placeholder stays for an anonymous reader", async () => {
    const reply = await getRecord(server, `${PATH}/1`);
    const error = body(reply)[0]?.error as Record<string, unknown>;
    expect(Object.keys(error)).toEqual(ERROR_KEYS);
    expect(error).toEqual({
      "response-code": 400,
      "developer-message":
        "400 Bad Request: The put code provided is not valid. Full validation error: '1' is not a valid put code",
      "user-message": `There was an error when updating the record. Please try again. If the error persists, please contact $\{clientName} for assistance.`,
      "error-code": 9034,
      "more-info": "https://members.orcid.org/api/resources/troubleshooting",
    });
  });

  test("a reader with a client gets the client's name in the message (source only)", async () => {
    const token = await obtainToken(server, {
      orcid: IDS.rich,
      scope: "/read-limited",
      client: "member",
    });
    const reply = await getRecord(server, `${PATH}/1`, { token: token.access_token });
    const error = body(reply)[0]?.error as Record<string, unknown>;
    expect(error["user-message"]).toBe(
      "There was an error when updating the record. Please try again. If the error persists, please contact orcid-mock member client for assistance.",
    );
  });

  test("a leading zero or a sign is read as the number: 007 asks for put-code 7", async () => {
    const reply = await getRecord(server, `${PATH}/007,+5501`);
    expect(kinds(reply)).toEqual(["work:5501", "error:9034"]);
    const second = body(reply)[1]?.error as { "developer-message": string };
    expect(second["developer-message"]).toContain("'7' is not a valid put code");
  });

  test("a trailing comma is ignored, and a list of only commas is an empty bulk", async () => {
    expect(kinds(await getRecord(server, `${PATH}/5501,`))).toEqual(["work:5501"]);
    const empty = await getRecord(server, `${PATH}/,`);
    expect(empty.status).toBe(200);
    expect(empty.text).toBe('{"bulk":[]}');
  });

  test("a trailing slash after the put-codes gives the same body", async () => {
    const plain = await getRecord(server, `${PATH}/5501,5503`);
    const slashed = await getRecord(server, `${PATH}/5501,5503/`);
    expect(slashed.status).toBe(200);
    expect(slashed.text).toBe(plain.text);
    expect((await getRecord(server, `${PATH}/abc/`)).status).toBe(400);
  });

  test("works/ with a trailing slash is the section, not an empty bulk", async () => {
    const reply = await getRecord(server, `${PATH}/`);
    expect(reply.status).toBe(200);
    expect(Object.keys(reply.json as object)).toEqual(["last-modified-date", "group", "path"]);
  });

  test("an element that is not a number fails the whole request: 400 / 9006", async () => {
    for (const [raw, shown] of [
      ["5501,abc", "abc"],
      ["1.5", "1.5"],
      ["5501,,5503", ""],
      [",5501", ""],
      ["abc,1.5", "abc"],
    ]) {
      const reply = await getRecord(server, `${PATH}/${raw}`);
      expect(reply.status).toBe(400);
      expect(reply.json).toEqual({
        "response-code": 400,
        "developer-message": `The client application sent a bad request to ORCID. Full validation error: For input string: "${shown}"`,
        "user-message": "The client application sent a bad request to ORCID.",
        "error-code": 9006,
        "more-info": "https://members.orcid.org/api/resources/troubleshooting",
      });
    }
  });

  test("100 put-codes are accepted and 101 are 400 / 9042, checked before any element is parsed", async () => {
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1).join(",");
    const ok = await getRecord(server, `${PATH}/${hundred}`);
    expect(ok.status).toBe(200);
    expect(body(ok)).toHaveLength(100);

    const many = await getRecord(server, `${PATH}/${hundred},101`);
    expect(many.status).toBe(400);
    expect(many.json).toEqual({
      "response-code": 400,
      "developer-message":
        "org.orcid.core.exception.ExceedMaxNumberOfPutCodesException Full validation error: Too many put codes specified: maximum is 100",
      "user-message": "Too many put codes supplied",
      "error-code": 9042,
      "more-info": "https://members.orcid.org/api/resources/troubleshooting",
    });
    const unparsed = await getRecord(server, `${PATH}/${hundred},abc`);
    expect((unparsed.json as { "error-code": number })["error-code"]).toBe(9042);
  });

  test("a work the reader may not see is a 9039 element in its place", async () => {
    const reply = await getRecord(server, `/v3.0/${R}/works/2001,2002,2003`);
    expect(kinds(reply)).toEqual(["work:2001", "error:9039", "error:9039"]);
    expect(body(reply)[1]).toEqual({
      error: {
        "response-code": 403,
        "developer-message":
          "403 Forbidden: The item is not public and cannot be accessed with the Public API.",
        "user-message": "The client application is forbidden to perform the action.",
        "error-code": 9039,
        "more-info": "https://members.orcid.org/api/resources/troubleshooting",
      },
    });
  });

  test("it checks only that the record exists: a deprecated, locked, or deactivated record answers 200", async () => {
    for (const orcid of [IDS.deprecated, IDS.locked, IDS.deactivated, IDS.unclaimed]) {
      const reply = await getRecord(server, `/v3.0/${orcid}/works/1`);
      expect(reply.status).toBe(200);
      expect(kinds(reply)).toEqual(["error:9034"]);
    }
    const unknown = await getRecord(server, "/v3.0/0000-0000-0000-0000/works/1");
    expect(unknown.status).toBe(404);
  });

  test("the body follows the negotiated style", async () => {
    const reply = await getRecord(server, `${PATH}/1`, { accept: "application/vnd.orcid+json" });
    expect(reply.headers.get("content-type")).toBe("application/vnd.orcid+json;charset=UTF-8");
    expect(
      reply.text.startsWith('{\n  "bulk" : [ {\n    "error" : {\n      "response-code" : 400,'),
    ).toBe(true);
  });
});
