// What every record read shares: the router-level middleware (bearer check and response headers),
// and `readRoute`, which negotiates the representation, checks the record's state, and hands the
// handler a context that writes the response in the negotiated style.
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { AppEnv } from "../../app";
import {
  jsonOnlyError,
  malformedAccept,
  ORCID_API_ERRORS,
  type OrcidApiErrorSpec,
  orcidApiError,
} from "../../errors";
import { invalidTokenResponse } from "../../oauth/bearer";
import { resolveRecordBearer } from "../../record/bearer";
import { compactJson, type Json, prettyJson } from "../../record/json";
import { type Negotiated, negotiate } from "../../record/negotiate";
import { type Blocked, blockedBy, existsOnly } from "../../record/status";
import { type Viewer, viewerFor } from "../../record/viewer";
import type { StoredUser, TokenRecord } from "../../store/types";

export type RecordEnv = {
  Variables: AppEnv["Variables"] & {
    /**
     * The valid access token the request presented, or null. Optional so that a record context
     * stays assignable to the `Context<AppEnv>` the shared bearer helpers take.
     */
    token?: TokenRecord | null;
  };
};
export type RecordContext = Context<RecordEnv>;

/**
 * Headers on every `/v3.0` response, errors included (observed on pub.orcid.org/v3.0 on
 * 2026-10-01). ORCID also sends `strict-transport-security`, `x-xss-protection`, and the
 * Cloudflare and Tomcat headers, which orcid-mock leaves out: they describe the host, not the
 * API.
 */
const RECORD_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "cache-control": "no-cache, no-store, max-age=0, must-revalidate",
  pragma: "no-cache",
  expires: "0",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function applyRecordHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(RECORD_HEADERS)) response.headers.set(name, value);
  return response;
}

/**
 * Router-level middleware, confined to `/v3.0/*` because the router is mounted there: a bad
 * bearer token is a 401 on every path, routed or not (ORCID's servlet filter runs before it
 * routes; observed on public paths), and every response gets the headers above.
 */
export const recordMiddleware: MiddlewareHandler<RecordEnv> = async (c, next) => {
  const { store } = c.get("deps");
  const bearer = await resolveRecordBearer(c, store);
  if (bearer.kind === "invalid")
    return applyRecordHeaders(invalidTokenResponse(c, bearer.presented));
  c.set("token", bearer.kind === "ok" ? bearer.token : null);
  await next();
  applyRecordHeaders(c.res);
};

/** What a read handler gets: the record, who is reading it, and writers for the answer. */
export interface ReadContext {
  c: RecordContext;
  user: StoredUser;
  viewer: Viewer;
  negotiated: Negotiated;
  /** The valid token the request presented, or null. */
  token: TokenRecord | null;
  /** A 200 with the body in the negotiated style and `Content-Type`. */
  send(body: Json): Response;
  /** An ORCID error in the negotiated style and `Content-Type`. */
  fail(spec: OrcidApiErrorSpec, headers?: Record<string, string>): Response;
}

type ReadHandler = (read: ReadContext) => Response | Promise<Response>;

/**
 * A 301, 404, or 409 for a record that is missing or in a state that blocks reads. A deprecated
 * record answers with `Location` at the primary record: the request's path with the iD swapped,
 * built from `PUBLIC_BASE_URL`, query string dropped (ORCID rebuilds it from the request URL
 * without the query):
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-api-common/src/main/java/org/orcid/api/common/jaxb/OrcidExceptionMapper.java#L375-L389
 */
function blockedSpec(
  c: RecordContext,
  blocked: Blocked,
  orcid: string,
  baseUrl: string,
): { spec: OrcidApiErrorSpec; headers?: Record<string, string> } {
  switch (blocked.kind) {
    case "not-found":
      return { spec: ORCID_API_ERRORS.notFound };
    case "unclaimed":
      return { spec: ORCID_API_ERRORS.unclaimed };
    case "locked":
      return { spec: ORCID_API_ERRORS.locked(orcid) };
    case "deactivated":
      return { spec: ORCID_API_ERRORS.deactivated(orcid) };
    case "deprecated": {
      // `/v3.0/<iD>` and what follows it, such as `/email` or a trailing slash.
      const suffix = new URL(c.req.url).pathname
        .split("/")
        .slice(3)
        .map((segment) => `/${segment}`)
        .join("");
      return {
        // ORCID's text shows `https://orcid.org/<iD>`; orcid-mock's is `PUBLIC_BASE_URL/<iD>`.
        spec: ORCID_API_ERRORS.deprecated(`${baseUrl}/${blocked.primary}`, `${baseUrl}/${orcid}`),
        headers: { Location: `${baseUrl}/v3.0/${blocked.primary}${suffix}` },
      };
    }
  }
}

/**
 * Registers a read route for each of `paths` and answers the other methods the way ORCID does:
 * GET (and HEAD, which Hono serves from GET) goes to `handler`; OPTIONS is a 200 with an
 * `Allow` header; any other method is 405 / 9001 with no Content-Type (observed).
 * Order for GET: `Accept` negotiation (406), then the record's state (404, 301, 409; bulk works
 * checks only that the record exists), then the handler.
 */
export function readRoute(
  app: Hono<RecordEnv>,
  paths: string[],
  handler: ReadHandler,
  opts: { existsOnly?: boolean } = {},
): void {
  const read = async (c: RecordContext): Promise<Response> => {
    const accept = c.req.header("accept");
    const negotiation = negotiate(accept);
    if (negotiation.kind === "malformed") return malformedAccept(c);
    if (negotiation.kind === "unsupported") return orcidApiError(c, ORCID_API_ERRORS.notAcceptable);
    if (negotiation.kind === "xml") return orcidApiError(c, jsonOnlyError(accept));
    const { negotiated } = negotiation;

    const deps = c.get("deps");
    const baseUrl = deps.config.publicBaseUrl;
    const fail = (spec: OrcidApiErrorSpec, headers?: Record<string, string>): Response =>
      orcidApiError(c, spec, {
        contentType: negotiated.contentType,
        pretty: negotiated.pretty,
        ...(headers === undefined ? {} : { headers }),
      });

    const orcid = c.req.param("id") ?? "";
    const user = await deps.store.getUser(orcid);
    const blocked = opts.existsOnly ? existsOnly(user) : blockedBy(user);
    if (user === null || blocked !== null) {
      const { spec, headers } = blockedSpec(c, blocked ?? { kind: "not-found" }, orcid, baseUrl);
      return fail(spec, headers);
    }

    const token = c.get("token") ?? null;
    return handler({
      c,
      user,
      viewer: viewerFor(token, user, baseUrl),
      negotiated,
      token,
      send: (body) =>
        c.body(negotiated.pretty ? prettyJson(body) : compactJson(body), 200, {
          "Content-Type": negotiated.contentType,
        }),
      fail,
    });
  };

  const options = (c: RecordContext): Response => {
    // Observed on pub.orcid.org/v3.0 on 2026-10-01: 200, an empty body, `Allow: HEAD,GET,OPTIONS`,
    // and a `Content-Type` that follows `Accept` (JSON echoed; XML, and so a missing `Accept`,
    // `application/vnd.orcid+xml;qs=0.5;charset=UTF-8`). A CORS preflight, which carries
    // `Access-Control-Request-Method`, also gets the two `Access-Control-Allow-*` headers.
    const negotiation = negotiate(c.req.header("accept"));
    if (negotiation.kind === "malformed") return malformedAccept(c);
    const headers: Record<string, string> = {
      "Content-Type":
        negotiation.kind === "json"
          ? negotiation.negotiated.contentType
          : "application/vnd.orcid+xml;qs=0.5;charset=UTF-8",
      Allow: "HEAD,GET,OPTIONS",
    };
    if (c.req.header("access-control-request-method") !== undefined) {
      headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE";
      headers["Access-Control-Allow-Headers"] = "X-Requested-With,Origin,Content-Type, Accept";
    }
    return c.body(null, 200, headers);
  };

  const methodNotAllowed = (c: RecordContext): Response =>
    orcidApiError(c, ORCID_API_ERRORS.methodNotAllowed);

  for (const path of paths) {
    app.get(path, read);
    app.options(path, options);
    app.all(path, methodNotAllowed);
  }
}
