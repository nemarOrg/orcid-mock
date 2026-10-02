import { Hono } from "hono";
import type { AppEnv } from "../app";

// Phase 3 (#6) fills this router. It is mounted at the root, so it declares full paths
// (/.well-known/openid-configuration, /oauth/jwks, /oauth/userinfo) and nothing else.
// Never call use("*") or any other wildcard middleware here: a root-mounted sub-app's wildcard
// middleware runs for every route registered after it, including /v3.0/*, so it would leak into
// the record API. Put route-specific middleware on the full path instead.
export function oidcRoutes(): Hono<AppEnv> {
  return new Hono<AppEnv>();
}
