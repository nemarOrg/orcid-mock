// Response headers the OpenID Connect routes share.
import type { Context } from "hono";
import { JSON_UTF8 } from "../errors";

/**
 * ORCID enables cross-domain reads for exactly three paths here, `/oauth/userinfo`, `/oauth/jwks`,
 * and `/.well-known/openid-configuration`, so a browser app can use them:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/web/filters/CrossDomainWebManger.java#L22
 * Its filter runs ahead of the controllers, so it covers their error answers too. It echoes the
 * request's `Origin` as `Access-Control-Allow-Origin`, which adds no header when the request has
 * none, and always adds `Access-Control-Allow-Credentials: true`:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/web/filters/CorsFilterWeb.java#L38-L41
 * The captures agree: discovery and the JWKS on orcid.org on 2026-10-01, requested without an
 * `Origin`, carried `access-control-allow-credentials: true`, no `access-control-allow-origin`,
 * and no `vary: origin`, so none is sent here.
 * The header goes on those routes only, never in middleware: this router is mounted at the root,
 * where a wildcard would reach the record API.
 */
export function corsHeaders(c: Context): Record<string, string> {
  const origin = c.req.header("origin");
  return {
    ...(origin === undefined ? {} : { "Access-Control-Allow-Origin": origin }),
    "Access-Control-Allow-Credentials": "true",
  };
}

/** The content type ORCID's OpenID Connect controllers answer with (observed for discovery). */
export const OIDC_JSON = { "Content-Type": JSON_UTF8 } as const;
