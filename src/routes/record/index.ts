// The public record API, v3.0, mounted at /v3.0. Router-level middleware here is safe and
// confined to /v3.0/* because of that mount (ADR 0002 forbids it only for routers mounted at the
// root).
import { Hono } from "hono";
import { ORCID_API_ERRORS, orcidApiError } from "../../errors";
import { type AffiliationKind, affiliationItem, affiliations } from "../../record/affiliations";
import { fundingItem, fundings } from "../../record/fundings";
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
import { parseJavaLong } from "../../record/putcode";
import type { ItemLookup } from "../../record/wire";
import { bulkWorks, workItem, works } from "../../record/works";
import { type ReadContext, type RecordEnv, readRoute, recordMiddleware } from "./read";

/** `/:id<tail>` and the same with a trailing slash, which ORCID serves for every read path. */
function withSlash(tail: string): string[] {
  return [`/:id${tail}`, `/:id${tail}/`];
}

/**
 * A single-item read: the put-code in the path is a Java `Long`, so a non-number is ORCID's 404
 * / 9001 with the `NumberFormatException` (observed for `/work/abc`); an item that is not in
 * this section of this record is 404 / 9016, and one the viewer may not see is 403 / 9039.
 */
function itemRead(read: ReadContext, lookup: (putCode: number) => ItemLookup): Response {
  const raw = read.c.req.param("pc") ?? "";
  const putCode = parseJavaLong(raw);
  if (putCode === null) return read.fail(ORCID_API_ERRORS.unroutedPutCode(raw));
  const found = lookup(Number(putCode));
  switch (found.kind) {
    case "ok":
      return read.send(found.json);
    case "hidden":
      return read.fail(ORCID_API_ERRORS.notPublic);
    case "missing":
      return read.fail(ORCID_API_ERRORS.notFound);
  }
}

export function recordRoutes(): Hono<RecordEnv> {
  const record = new Hono<RecordEnv>();
  record.use("*", recordMiddleware);

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
    readRoute(record, withSlash(`${segment}/:pc`), (r) =>
      itemRead(r, (putCode) => section.item(r.user, r.viewer, putCode)),
    );
  }

  // The seven affiliation sections; only employments, educations, and qualifications have items
  // in a fixture, so the other four are always empty and have no item route.
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
  }
  for (const kind of ["employment", "education", "qualification"] as const) {
    readRoute(record, withSlash(`/${kind}/:pc`), (r) =>
      itemRead(r, (putCode) => affiliationItem(r.user, r.viewer, kind, putCode)),
    );
  }

  readRoute(record, withSlash("/fundings"), (r) => r.send(fundings(r.user, r.viewer).json));
  readRoute(record, withSlash("/funding/:pc"), (r) =>
    itemRead(r, (putCode) => fundingItem(r.user, r.viewer, putCode)),
  );
  readRoute(record, withSlash("/peer-reviews"), (r) => r.send(peerReviews(r.user, r.viewer).json));
  readRoute(record, withSlash("/peer-review/:pc"), (r) =>
    itemRead(r, (putCode) => peerReviewItem(r.user, r.viewer, putCode)),
  );
  readRoute(record, withSlash("/works"), (r) => r.send(works(r.user, r.viewer).json));
  readRoute(record, withSlash("/work/:pc"), (r) =>
    itemRead(r, (putCode) => workItem(r.user, r.viewer, putCode)),
  );
  // Bulk checks only that the record exists (`existsOnly`), so a deprecated, locked, or
  // deactivated record is read like any other (observed for a deprecated one).
  readRoute(
    record,
    ["/:id/works/:codes"],
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

  // Anything else under /v3.0: `GET /v3.0/` is a 406 and every other unrouted path a 404, both
  // 9001 with no Content-Type (observed on pub.orcid.org/v3.0 on 2026-10-01). Hono's `route()`
  // drops a sub-app's notFound, so this catch-all keeps the response headers on these too.
  record.all("*", (c) =>
    orcidApiError(
      c,
      c.req.path === "/v3.0/" ? ORCID_API_ERRORS.notAcceptable : ORCID_API_ERRORS.unrouted,
    ),
  );
  return record;
}
