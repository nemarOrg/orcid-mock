// Response headers the OpenID Connect routes share.
import { JSON_UTF8 } from "../errors";

/**
 * ORCID enables cross-domain reads for exactly three paths here, `/oauth/userinfo`, `/oauth/jwks`,
 * and `/.well-known/openid-configuration`, so a browser app can use them:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/web/filters/CrossDomainWebManger.java#L22
 * Its filter echoes the request's `Origin` and adds `Access-Control-Allow-Credentials: true`:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/web/filters/CorsFilterWeb.java#L38-L41
 * orcid-mock choice: `*`, with no credentials flag, which needs no request header and is what a
 * test client without cookies wants. The header goes on those routes only, never in middleware:
 * this router is mounted at the root, where a wildcard would reach the record API.
 */
export const CORS_ANY_ORIGIN = { "Access-Control-Allow-Origin": "*" } as const;

/** The content type ORCID's OpenID Connect controllers answer with (observed for discovery). */
export const OIDC_JSON = { "Content-Type": JSON_UTF8 } as const;

/** What ORCID sends with its JWKS and its userinfo 403 (observed on orcid.org on 2026-10-01). */
export const NO_STORE = {
  "Cache-Control": "no-cache, no-store, max-age=0, must-revalidate",
} as const;
