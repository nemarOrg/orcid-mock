// The public record API, v3.0, mounted at /v3.0. Router-level middleware here is safe and
// confined to /v3.0/* because of that mount (ADR 0002 forbids it only for routers mounted at the
// root).
import { Hono } from "hono";
import { malformedAccept, ORCID_API_ERRORS, orcidApiError } from "../../errors";
import { activities, researchResources } from "../../record/activities";
import { type AffiliationKind, affiliationItem, affiliations } from "../../record/affiliations";
import { fundingItem, fundings } from "../../record/fundings";
import { negotiate } from "../../record/negotiate";
import { peerReviewItem, peerReviews } from "../../record/peer-reviews";
import {
  addresses,
  biography,
  emails,
  externalIdentifiers,
  keywords,
  otherNames,
  person,
  personalDetails,
  researcherUrls,
} from "../../record/person";
import { record as recordBody } from "../../record/record";
import type { ItemLookup } from "../../record/wire";
import { bulkWorks, workItem, works } from "../../record/works";
import {
  methodNotAllowedResponse,
  optionsResponse,
  type ReadContext,
  type RecordEnv,
  readRoute,
  recordMiddleware,
} from "./read";

/** `/:id<tail>` and the same with a trailing slash, which ORCID serves for every read path. */
function withSlash(tail: string): string[] {
  return [`/:id${tail}`, `/:id${tail}/`];
}

/**
 * A single-item read, for a route registered with `putCode` (the path's put-code is read, and a
 * non-number answered, before the record's state is checked): an item that is not in this
 * section of this record is 404 / 9016, one the viewer may not see is 403 / 9039.
 */
function itemRead(read: ReadContext, lookup: (putCode: number) => ItemLookup): Response {
  const found = lookup(read.putCode as number);
  switch (found.kind) {
    case "ok":
      return read.send(found.json);
    case "hidden":
      return read.fail(ORCID_API_ERRORS.notPublic);
    case "bad-request":
      return read.fail(ORCID_API_ERRORS.badRequest(found.detail));
    case "missing":
      return read.fail(ORCID_API_ERRORS.notFound);
  }
}

/** The kinds whose put-code ORCID converts in the path declaration (see `PutCodeConversion`). */
const PATH_LONG_KINDS = new Set(["/work", "/funding", "/education", "/employment", "/peer-review"]);

/** `/:id<tail>/:pc` (and a trailing slash): a single-item read with its put-code converted first. */
function itemRoute(
  app: Hono<RecordEnv>,
  tail: string,
  lookup: (read: ReadContext, putCode: number) => ItemLookup,
): void {
  readRoute(app, withSlash(`${tail}/:pc`), (r) => itemRead(r, (putCode) => lookup(r, putCode)), {
    putCode: PATH_LONG_KINDS.has(tail) ? "path" : "method",
  });
}

export function recordRoutes(): Hono<RecordEnv> {
  const record = new Hono<RecordEnv>();
  record.use("*", recordMiddleware);

  // The whole record: `/{iD}`, `/{iD}/`, `/{iD}/record`, and `/{iD}/record/` are one body.
  readRoute(record, ["/:id", "/:id/", ...withSlash("/record")], (r) =>
    r.send(recordBody(r.user, r.viewer)),
  );
  readRoute(record, withSlash("/activities"), (r) => r.send(activities(r.user, r.viewer).json));
  readRoute(record, withSlash("/research-resources"), (r) =>
    r.send(researchResources(r.user).json),
  );
  readRoute(record, withSlash("/person"), (r) => r.send(person(r.user, r.viewer).json));
  readRoute(record, withSlash("/personal-details"), (r) =>
    r.send(personalDetails(r.user, r.viewer).json),
  );
  readRoute(record, withSlash("/email"), (r) => r.send(emails(r.user, r.viewer).json));
  readRoute(record, withSlash("/biography"), (r) => {
    const bio = biography(r.user, r.viewer);
    switch (bio.state) {
      case "visible":
        return r.send(bio.built.json);
      case "hidden":
        return r.fail(ORCID_API_ERRORS.notPublic);
      case "absent":
        return r.fail(ORCID_API_ERRORS.noBiography);
    }
  });

  const lists = [
    ["/address", addresses],
    ["/other-names", otherNames],
    ["/keywords", keywords],
    ["/external-identifiers", externalIdentifiers],
    ["/researcher-urls", researcherUrls],
  ] as const;
  for (const [segment, section] of lists) {
    readRoute(record, withSlash(segment), (r) => r.send(section.container(r.user, r.viewer).json));
    itemRoute(record, segment, (r, putCode) => section.item(r.user, r.viewer, putCode));
  }

  // The seven affiliation sections. A fixture has items for employments, educations, and
  // qualifications only, so the other four are always empty, but they have item routes too: ORCID
  // routes them (and `research-resource/{pc}`), checks the record, and answers 404 / 9016.
  const sections = [
    ["/employments", "employment"],
    ["/educations", "education"],
    ["/qualifications", "qualification"],
    ["/distinctions", "distinction"],
    ["/invited-positions", "invited-position"],
    ["/memberships", "membership"],
    ["/services", "service"],
  ] as const satisfies ReadonlyArray<readonly [string, AffiliationKind]>;
  for (const [segment, kind] of sections) {
    readRoute(record, withSlash(segment), (r) => r.send(affiliations(r.user, r.viewer, kind).json));
    itemRoute(record, `/${kind}`, (r, putCode) => affiliationItem(r.user, r.viewer, kind, putCode));
  }
  itemRoute(record, "/research-resource", () => ({ kind: "missing" }));

  readRoute(record, withSlash("/fundings"), (r) => r.send(fundings(r.user, r.viewer).json));
  itemRoute(record, "/funding", (r, putCode) => fundingItem(r.user, r.viewer, putCode));
  readRoute(record, withSlash("/peer-reviews"), (r) => r.send(peerReviews(r.user, r.viewer).json));
  itemRoute(record, "/peer-review", (r, putCode) => peerReviewItem(r.user, r.viewer, putCode));
  readRoute(record, withSlash("/works"), (r) => r.send(works(r.user, r.viewer).json));
  itemRoute(record, "/work", (r, putCode) => workItem(r.user, r.viewer, putCode));
  // Bulk checks only that the record exists (`existsOnly`), so a deprecated, locked, or
  // deactivated record is read like any other (observed for a deprecated one).
  readRoute(
    record,
    // A trailing slash is served here too (observed: `works/{pc}/` answers 200 with the same body).
    ["/:id/works/:codes", "/:id/works/:codes/"],
    async (r) => {
      // ORCID fills `${clientName}` in a 9034 message with the calling client's name.
      const { store } = r.c.get("deps");
      const client = r.token === null ? null : await store.getClient(r.token.client_id);
      const result = bulkWorks(
        r.user,
        r.viewer,
        r.c.req.param("codes") ?? "",
        client?.name ?? null,
      );
      switch (result.kind) {
        case "too-many":
          return r.fail(ORCID_API_ERRORS.tooManyPutCodes);
        case "bad-element":
          return r.fail(ORCID_API_ERRORS.badPutCode(result.raw));
        case "ok":
          return r.send(result.body);
      }
    },
    { existsOnly: true },
  );

  // Anything else under /v3.0: every other unrouted path is a 404 / 9001 with no Content-Type
  // (observed on pub.orcid.org/v3.0 on 2026-10-01), a 404 before any header is read. Hono's
  // `route()` drops a sub-app's notFound, so this catch-all keeps the response headers on it too.
  // `/v3.0/` is a resource of ORCID's: GET is a 406 / 9001 (a 400 page for an `Accept` that does
  // not parse), OPTIONS is a 200, and any other method is a 405.
  record.all("*", (c) => {
    if (c.req.path !== "/v3.0/") return orcidApiError(c, ORCID_API_ERRORS.unrouted);
    switch (c.req.method) {
      case "GET":
      case "HEAD":
        if (negotiate(c.req.header("accept")).kind === "malformed") return malformedAccept(c);
        return orcidApiError(c, ORCID_API_ERRORS.notAcceptable);
      case "OPTIONS":
        return optionsResponse(c);
      default:
        return methodNotAllowedResponse(c);
    }
  });
  return record;
}
