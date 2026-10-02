// The record-state checks every record-scoped read runs, in ORCID's order: unknown iD (404 / 9016),
// deprecated (301 / 9007), unclaimed (409 / 9036), locked (409 / 9018), deactivated (409 / 9044).
// Bodies and statuses observed on pub.orcid.org/v3.0 on 2026-10-01, except unclaimed and locked,
// which are source only (no such record could be found to observe).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { IDS, RECORD_USERS_FILE } from "./fixtures/record";
import { startTestServer, type TestServer } from "./harness";
import { ERROR_KEYS, getRecord, RECORD_HEADERS, type RecordReply } from "./helpers/record";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer({ users: RECORD_USERS_FILE });
}, 10_000);
beforeEach(() => server.reset());
afterAll(() => server.stop());

const MORE_INFO = "https://members.orcid.org/api/resources/troubleshooting";

function expectError(
  reply: RecordReply,
  expected: { status: number; code: number; developer: string; user: string },
) {
  expect(reply.status).toBe(expected.status);
  expect(Object.keys(reply.json as object)).toEqual(ERROR_KEYS);
  expect(reply.json).toEqual({
    "response-code": expected.status,
    "developer-message": expected.developer,
    "user-message": expected.user,
    "error-code": expected.code,
    "more-info": MORE_INFO,
  });
  expect(reply.headers.get("content-type")).toBe("application/json;charset=UTF-8");
  for (const [name, value] of Object.entries(RECORD_HEADERS)) {
    expect(reply.headers.get(name)).toBe(value);
  }
}

const NOT_FOUND = {
  status: 404,
  code: 9016,
  developer: "404 Not Found: The resource was not found.",
  user: "The resource was not found.",
};

describe("an unknown or malformed iD is 404 / 9016, with no checksum check", () => {
  for (const iD of [
    "0000-0000-0000-0000",
    "not-an-orcid",
    "0000-0002-1825",
    "0000-0002-1694-233x",
    // Right shape, wrong check character.
    "0000-0002-1825-0098",
    "0009-9310-3508-7526",
    // A real iD with a trailing space is another string.
    "0009-9310-3508-7525%20",
  ]) {
    test(iD, async () => {
      expectError(await getRecord(server, `/v3.0/${iD}/email`), NOT_FOUND);
    });
  }
});

describe("a deprecated record is a 301 to the primary record", () => {
  const own = () => `${server.publicBaseUrl}/${IDS.deprecated}`;
  const primary = () => `${server.publicBaseUrl}/${IDS.primary}`;

  test("the body is 9007 with the iDs filled in, in PUBLIC_BASE_URL form", async () => {
    const reply = await getRecord(server, `/v3.0/${IDS.deprecated}/email`);
    expectError(reply, {
      status: 301,
      code: 9007,
      developer: `301 Moved Permanently: This account is deprecated. Please refer to account: ${primary()}. ORCID ${own()}`,
      user: `This account is deprecated. Please refer to account: ${primary()}.`,
    });
  });

  test("Location is the same path with the primary iD, as an absolute URL", async () => {
    const reply = await getRecord(server, `/v3.0/${IDS.deprecated}/email`);
    expect(reply.headers.get("location")).toBe(`${server.publicBaseUrl}/v3.0/${IDS.primary}/email`);
  });

  test("the path suffix and a trailing slash carry over, and the query string does not", async () => {
    const slashed = await getRecord(server, `/v3.0/${IDS.deprecated}/email/`);
    expect(slashed.headers.get("location")).toBe(
      `${server.publicBaseUrl}/v3.0/${IDS.primary}/email/`,
    );
    const queried = await getRecord(server, `/v3.0/${IDS.deprecated}/email?access_token=&x=1`);
    expect(queried.headers.get("location")).toBe(
      `${server.publicBaseUrl}/v3.0/${IDS.primary}/email`,
    );
  });

  test("the redirect points at a record that answers", async () => {
    const first = await getRecord(server, `/v3.0/${IDS.deprecated}/email`);
    const next = await getRecord(server, new URL(first.headers.get("location") ?? "").pathname);
    expect(next.status).toBe(200);
  });

  test("the body follows the negotiated style", async () => {
    const reply = await getRecord(server, `/v3.0/${IDS.deprecated}/email`, {
      accept: "application/vnd.orcid+json",
    });
    expect(reply.status).toBe(301);
    expect(reply.headers.get("content-type")).toBe("application/vnd.orcid+json;charset=UTF-8");
    expect(reply.text.startsWith('{\n  "response-code" : 301,')).toBe(true);
  });

  test("HEAD carries the Location too", async () => {
    const reply = await getRecord(server, `/v3.0/${IDS.deprecated}/email`, { method: "HEAD" });
    expect(reply.status).toBe(301);
    expect(reply.headers.get("location")).toBe(`${server.publicBaseUrl}/v3.0/${IDS.primary}/email`);
  });
});

describe("a record in another state is a 409", () => {
  test("unclaimed is 409 / 9036 (source only)", async () => {
    expectError(await getRecord(server, `/v3.0/${IDS.unclaimed}/email`), {
      status: 409,
      code: 9036,
      developer: "409 Conflict: This record has not been claimed.",
      user: "This record has not been claimed, if this is your record you can claim it at https://orcid.org/resend-claim.",
    });
  });

  test("locked is 409 / 9018 (source only)", async () => {
    expectError(await getRecord(server, `/v3.0/${IDS.locked}/email`), {
      status: 409,
      code: 9018,
      developer: `409 Conflict: The ORCID record is locked and cannot be edited. ORCID ${IDS.locked} Full validation error: ${IDS.locked} is locked`,
      user: "The ORCID record is locked.",
    });
  });

  test("deactivated is 409 / 9044", async () => {
    expectError(await getRecord(server, `/v3.0/${IDS.deactivated}/email`), {
      status: 409,
      code: 9044,
      developer: `409 Conflict: The ORCID record is deactivated and cannot be edited. Full validation error: ${IDS.deactivated} is deactivated`,
      user: "The ORCID record is deactivated.",
    });
  });
});

describe("the checks run in ORCID's order", () => {
  test("deprecated before locked", async () => {
    const reply = await getRecord(server, `/v3.0/${IDS.deprecatedLocked}/email`);
    expect(reply.status).toBe(301);
    expect(reply.headers.get("location")).toBe(`${server.publicBaseUrl}/v3.0/${IDS.primary}/email`);
  });

  test("unclaimed before locked", async () => {
    const reply = await getRecord(server, `/v3.0/${IDS.unclaimedLocked}/email`);
    expect((reply.json as { "error-code": number })["error-code"]).toBe(9036);
  });

  test("locked before deactivated", async () => {
    const reply = await getRecord(server, `/v3.0/${IDS.lockedDeactivated}/email`);
    expect((reply.json as { "error-code": number })["error-code"]).toBe(9018);
  });
});

// Every record-scoped read path, with a put-code where it takes one. The state checks come before
// any of them is served; only the bulk read, below, differs.
const READ_PATHS = [
  "",
  "/",
  "/record",
  "/record/",
  "/activities",
  "/research-resources",
  "/person",
  "/personal-details",
  "/email",
  "/biography",
  "/address",
  "/other-names",
  "/keywords",
  "/external-identifiers",
  "/researcher-urls",
  "/employments",
  "/educations",
  "/qualifications",
  "/distinctions",
  "/invited-positions",
  "/memberships",
  "/services",
  "/fundings",
  "/peer-reviews",
  "/works",
  "/works/",
  "/work/1",
  "/employment/1",
  "/education/1",
  "/qualification/1",
  "/funding/1",
  "/peer-review/1",
  "/other-names/1",
  "/keywords/1",
  "/researcher-urls/1",
  "/external-identifiers/1",
  "/address/1",
];

describe("every read path checks the record's state", () => {
  test("an unknown iD is 404 / 9016 on every path", async () => {
    for (const suffix of READ_PATHS) {
      const reply = await getRecord(server, `/v3.0/0000-0000-0000-0000${suffix}`);
      expect([
        suffix,
        reply.status,
        (reply.json as { "error-code": number })["error-code"],
      ]).toEqual([suffix, 404, 9016]);
    }
  });

  test("a deprecated record is a 301 to the same path on the primary record, on every path", async () => {
    for (const suffix of READ_PATHS) {
      const reply = await getRecord(server, `/v3.0/${IDS.deprecated}${suffix}`);
      expect([suffix, reply.status]).toEqual([suffix, 301]);
      expect(reply.headers.get("location")).toBe(
        `${server.publicBaseUrl}/v3.0/${IDS.primary}${suffix}`,
      );
    }
  });

  test("unclaimed, locked, and deactivated are 409 / 9036, 9018, and 9044 on every path", async () => {
    for (const [orcid, code] of [
      [IDS.unclaimed, 9036],
      [IDS.locked, 9018],
      [IDS.deactivated, 9044],
    ] as const) {
      for (const suffix of READ_PATHS) {
        const reply = await getRecord(server, `/v3.0/${orcid}${suffix}`);
        expect([
          suffix,
          reply.status,
          (reply.json as { "error-code": number })["error-code"],
        ]).toEqual([suffix, 409, code]);
      }
    }
  });

  test("a healthy record serves every section path (the item paths find no put-code 1)", async () => {
    for (const suffix of READ_PATHS) {
      const reply = await getRecord(server, `/v3.0/${IDS.rich}${suffix}`);
      const item = /\/[a-z-]+\/1$/.test(suffix) && !suffix.startsWith("/works");
      expect([suffix, reply.status]).toEqual([suffix, item ? 404 : 200]);
    }
  });

  test("bulk works checks only that the record exists: the states do not apply", async () => {
    for (const orcid of [IDS.deprecated, IDS.unclaimed, IDS.locked, IDS.deactivated]) {
      expect((await getRecord(server, `/v3.0/${orcid}/works/1`)).status).toBe(200);
    }
    expect((await getRecord(server, "/v3.0/0000-0000-0000-0000/works/1")).status).toBe(404);
  });
});
