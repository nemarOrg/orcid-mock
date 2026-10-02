// Response headers shared by more than one family of routes.

/**
 * The cache headers ORCID sends on the answers the mock copies, which are one set of web-framework
 * defaults: `cache-control: no-cache, no-store, max-age=0, must-revalidate`, `pragma: no-cache`,
 * and `expires: 0`. Captured with all three on the JWKS (orcid.org, 2026-10-01) and on every
 * record API response, errors included (pub.orcid.org/v3.0, 2026-10-01); the userinfo 403 was
 * captured with the same `cache-control` on sandbox.orcid.org on 2026-10-01, and orcid-mock
 * assumes the other two go with it.
 */
export const NO_STORE = {
  "Cache-Control": "no-cache, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
} as const;
