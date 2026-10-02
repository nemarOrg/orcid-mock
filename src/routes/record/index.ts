// The public record API, v3.0, mounted at /v3.0. Router-level middleware here is safe and
// confined to /v3.0/* because of that mount (ADR 0002 forbids it only for routers mounted at the
// root).
import { Hono } from "hono";
import { ORCID_API_ERRORS, orcidApiError } from "../../errors";
import { emails } from "../../record/person";
import { type RecordEnv, readRoute, recordMiddleware } from "./read";

/** `/:id/<tail>` and the same with a trailing slash, which ORCID serves for every read path. */
function withSlash(tail: string): string[] {
  return [`/:id${tail}`, `/:id${tail}/`];
}

export function recordRoutes(): Hono<RecordEnv> {
  const record = new Hono<RecordEnv>();
  record.use("*", recordMiddleware);

  readRoute(record, withSlash("/email"), (read) => read.send(emails(read.user, read.viewer).json));

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
