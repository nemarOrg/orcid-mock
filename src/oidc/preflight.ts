// The CORS preflight answer for the three cross-domain OpenID Connect routes.
import type { Context } from "hono";
import type { AppEnv } from "../app";
import { CORS_ANY_ORIGIN } from "./headers";

/**
 * A browser sends this before a cross-origin request that carries an `Authorization` header, such
 * as userinfo with a bearer token. ORCID's filter answers an `OPTIONS` request that has an
 * `Access-Control-Request-Method` header with an empty 200 and these two lists, and lets any
 * other `OPTIONS` request through to the controller, which has no `OPTIONS` route here either:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/web/filters/CorsFilterWeb.java#L43-L47
 */
export function corsPreflight(c: Context<AppEnv>): Response | Promise<Response> {
  if (c.req.header("access-control-request-method") === undefined) return c.notFound();
  return c.body(null, 200, {
    ...CORS_ANY_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE",
    "Access-Control-Allow-Headers":
      "X-Requested-With,Origin,Content-Type,Accept,Authorization,x-csrf-token,x-xsrf-token",
  });
}
