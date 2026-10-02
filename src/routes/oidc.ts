import { Hono } from "hono";
import type { AppEnv } from "../app";
import { jwksEndpoint } from "../oidc/jwks";

// ORCID's OpenID Connect routes: /.well-known/openid-configuration, /oauth/jwks, and
// /oauth/userinfo. The router is mounted at the root, so it declares full paths and nothing else.
// Never call use("*") or any other wildcard middleware here: a root-mounted sub-app's wildcard
// middleware runs for every route registered after it, including /v3.0/*, so it would leak into
// the record API. Put route-specific middleware on the full path instead.
export function oidcRoutes(): Hono<AppEnv> {
  const oidc = new Hono<AppEnv>();
  oidc.get("/oauth/jwks", jwksEndpoint);
  return oidc;
}
