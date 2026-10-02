import { Hono } from "hono";
import type { AppEnv } from "../app";

// Phase 3 (#6) fills this router, mounted at the root: it declares its full paths
// (/.well-known/openid-configuration, /oauth/jwks, /oauth/userinfo).
export function oidcRoutes(): Hono<AppEnv> {
  return new Hono<AppEnv>();
}
