// One suite, two targets: the same assertions against orcid-mock and against ORCID's sandbox, with
// the client code in client.ts unchanged. Run it with `bun run conformance`; the Conformance
// section of the README says how to point it at each target.
//
// The assertions are structural: status, headers, the exact keys of every body in ORCID's order,
// and the kind of each value. They say nothing about counts or values, because a fixture and a
// real record hold different data. A case that passes on the sandbox is a claim about ORCID, and
// a case that passes on the mock is a claim about the mock, so the two should always agree.
//
// Cases (the letter groups the describe blocks, so `-t "A:"` runs one group):
//
//   T  Token endpoint (needs ORCID_CLIENT_ID and ORCID_CLIENT_SECRET to be valid)
//      T1  client credentials with /read-public: 200, JSON, the keys access_token, token_type,
//          refresh_token, expires_in, scope, orcid in that order; token_type "bearer", scope
//          "/read-public", orcid null, no name, and expires_in above ten years.
//
//   A  Public reads of ORCID_PUBLIC_ID with no token (needs nothing)
//      A1-A6  personal-details, person, record, works, employments, email: 200, JSON, the
//             container keys in order, every path value, and the keys and value types of every
//             item present; the name is public, so name.given-names.value is a string.
//
//   B  The same six reads with the client-credentials bearer token (needs T1 to pass)
//      B1-B6  200 and the same structure as A1-A6.
//
//   E  Error shapes (need nothing valid; E1 sends a wrong secret, E2 no credentials at all)
//      E1  token request with a wrong client secret: 401, invalid_client.
//      E2  token request with JSON instead of a form: 415, an HTML page, and an Accept header
//          that names the form type.
//      E3  record read with a bad bearer: 401, invalid_token, the token echoed, no
//          WWW-Authenticate header.
//      E4  an iD no record has: 404, error 9016.
//      E5  an iD with a wrong check character: 404, error 9016 (reads do no checksum check).
//      E6  Accept: text/csv: 406, error 9001, no Content-Type header.
//      E7  101 put-codes on bulk works: 400, error 9042.
//
// Where orcid-mock deliberately differs from ORCID, the suite avoids the case or asserts what both
// satisfy, so no assertion branches on the target:
//   - A missing or wildcard Accept header: ORCID answers XML and orcid-mock a 406 (ADR 0007).
//     Every read here sends Accept explicitly, and the client always does.
//   - URIs: orcid-mock writes PUBLIC_BASE_URL where ORCID writes https://orcid.org (ADR 0001 and
//     0007), so orcid-identifier is checked for agreeing with itself and not for its host, and the
//     source objects only for their keys.
//   - The 415 body: ORCID answers a Tomcat error page and orcid-mock the sentence alone
//     (ADR 0004), so E2 looks for the sentence inside the body.
// What the record holds is never asserted, so the fixture and the sandbox may differ freely.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createClient, type Reply } from "./client";
import {
  apiError,
  check,
  clientCredentialsGrant,
  invalidClient,
  invalidToken,
  recordShapes,
  type Shape,
} from "./shapes";
import { loadTarget } from "./target";

// A sandbox answers in well under a second, but a request that hangs should fail the case with
// the request's own error and not Bun's default five seconds.
setDefaultTimeout(30_000);

const target = loadTarget();
const client = createClient(target);
const shapes = recordShapes(target.publicId);

/** ORCID's access tokens last about twenty years; ten is the line the suite draws. */
const TEN_YEARS_SECONDS = 10 * 365 * 24 * 60 * 60;

/**
 * An iD with a valid check character that no record has: it lies above the blocks ORCID assigns
 * from (ADR 0003). The obvious 0000-0000-0000-0001 is not safe, since the sandbox has a record
 * there.
 */
const UNASSIGNED_ID = "0009-9999-9999-9992";
/** A token that no server has issued. */
const NEVER_ISSUED_TOKEN = "00000000-0000-0000-0000-000000000000";

/** `target.publicId` with the wrong check character, which no record can have. */
const BAD_CHECKSUM_ID = `${target.publicId.slice(0, -1)}${target.publicId.endsWith("0") ? "1" : "0"}`;

function contentType(reply: Reply): string {
  return reply.headers.get("content-type") ?? "";
}

/** ORCID's web server HTML-escapes the sentence in its error page; a browser shows it plain. */
function decodeEntities(html: string): string {
  return html
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** 200 and JSON, with the body's structure checked against `shape`. */
function expectRecordRead(reply: Reply, shape: Shape): void {
  expect(reply.status).toBe(200);
  expect(contentType(reply)).toStartWith("application/json");
  expect(check(reply.json, shape)).toEqual([]);
}

/** A record API error: the status, the five keys, the `response-code`, and the `error-code`. */
function expectApiError(reply: Reply, status: number, code: number): void {
  expect(reply.status).toBe(status);
  expect(check(reply.json, apiError)).toEqual([]);
  const body = reply.json as { "response-code": number; "error-code": number };
  expect(body["response-code"]).toBe(status);
  expect(body["error-code"]).toBe(code);
}

/** The six reads of A and B: what each section's body must look like. */
const READS: ReadonlyArray<{
  section: string;
  shape: Shape;
  /** Checks beyond the structure. */
  also?: (json: Record<string, unknown>) => void;
}> = [
  {
    section: "personal-details",
    shape: shapes.personalDetails,
    also: (json) => {
      const name = json.name as { "given-names": { value: unknown } };
      expect(typeof name["given-names"].value).toBe("string");
    },
  },
  { section: "person", shape: shapes.person },
  {
    section: "record",
    shape: shapes.record,
    also: (json) => {
      // ORCID writes https://orcid.org/<iD> and orcid-mock writes PUBLIC_BASE_URL/<iD>, so the
      // identifier is held to agreeing with itself.
      const identifier = json["orcid-identifier"] as { uri: string; path: string; host: string };
      const uri = new URL(identifier.uri);
      expect(identifier.path).toBe(target.publicId);
      expect(uri.host).toBe(identifier.host);
      expect(uri.pathname).toBe(`/${target.publicId}`);
    },
  },
  { section: "works", shape: shapes.works },
  { section: "employments", shape: shapes.employments },
  { section: "email", shape: shapes.email },
];

describe("T: token endpoint", () => {
  test("T1 client credentials with /read-public", async () => {
    const reply = await client.clientCredentials();
    expect(reply.status).toBe(200);
    expect(contentType(reply)).toStartWith("application/json");
    // The keys, their order, and their types; a `name` key would break the order.
    expect(check(reply.json, clientCredentialsGrant)).toEqual([]);
    const grant = reply.json as { expires_in: number };
    expect(Number.isInteger(grant.expires_in)).toBe(true);
    expect(grant.expires_in).toBeGreaterThan(TEN_YEARS_SECONDS);
  });
});

describe("A: anonymous public reads", () => {
  for (const [index, { section, shape, also }] of READS.entries()) {
    test(`A${index + 1} ${section}`, async () => {
      const reply = await client.readRecord(target.publicId, section);
      expectRecordRead(reply, shape);
      also?.(reply.json as Record<string, unknown>);
    });
  }
});

describe("B: public reads with a bearer token", () => {
  for (const [index, { section, shape, also }] of READS.entries()) {
    test(`B${index + 1} ${section}`, async () => {
      const token = await client.clientCredentialsToken();
      const reply = await client.readRecord(target.publicId, section, token);
      expectRecordRead(reply, shape);
      also?.(reply.json as Record<string, unknown>);
    });
  }
});

describe("E: error shapes", () => {
  test("E1 a wrong client secret is 401 invalid_client", async () => {
    const reply = await client.tokenRequest({
      grant_type: "client_credentials",
      scope: "/read-public",
      client_id: target.clientId,
      client_secret: `wrong-${crypto.randomUUID()}`,
    });
    expect(reply.status).toBe(401);
    expect(contentType(reply)).toStartWith("application/json");
    expect(check(reply.json, invalidClient)).toEqual([]);
  });

  test("E2 a JSON body instead of a form is 415", async () => {
    // No credentials: the request is refused before anyone looks at them.
    const reply = await client.request(client.tokenUrl, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", scope: "/read-public" }),
    });
    expect(reply.status).toBe(415);
    expect(contentType(reply)).toStartWith("text/html");
    expect(reply.headers.get("accept")).toBe("application/x-www-form-urlencoded");
    expect(decodeEntities(reply.text)).toContain(
      "Content-Type 'application/json' is not supported.",
    );
  });

  test("E3 a bad bearer is 401 invalid_token with the token echoed", async () => {
    const reply = await client.readRecord(target.publicId, "record", NEVER_ISSUED_TOKEN);
    expect(reply.status).toBe(401);
    expect(contentType(reply)).toStartWith("application/json");
    expect(check(reply.json, invalidToken)).toEqual([]);
    const body = reply.json as { error_description: string };
    expect(body.error_description).toBe(`Invalid access token: ${NEVER_ISSUED_TOKEN}`);
    expect(reply.headers.has("www-authenticate")).toBe(false);
  });

  test("E4 an unknown iD is 404 with error 9016", async () => {
    const reply = await client.readRecord(UNASSIGNED_ID, "personal-details");
    expectApiError(reply, 404, 9016);
    expect(contentType(reply)).toStartWith("application/json");
  });

  test("E5 an iD with a wrong check character is 404 with error 9016", async () => {
    expect(BAD_CHECKSUM_ID).not.toBe(target.publicId);
    const reply = await client.readRecord(BAD_CHECKSUM_ID, "personal-details");
    expectApiError(reply, 404, 9016);
    expect(contentType(reply)).toStartWith("application/json");
  });

  test("E6 Accept: text/csv is 406 with error 9001 and no Content-Type", async () => {
    const reply = await client.readRecord(
      target.publicId,
      "personal-details",
      undefined,
      "text/csv",
    );
    expectApiError(reply, 406, 9001);
    expect(reply.headers.has("content-type")).toBe(false);
  });

  test("E7 101 put-codes on bulk works is 400 with error 9042", async () => {
    const putCodes = Array.from({ length: 101 }, (_, index) => index + 1);
    const reply = await client.readWorks(target.publicId, putCodes);
    expectApiError(reply, 400, 9042);
    expect(contentType(reply)).toStartWith("application/json");
  });
});
