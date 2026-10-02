import { Hono } from "hono";
import type { AppEnv } from "../app";

// Phase 2 (#5) fills this router: /authorize, /token, /revoke.
export function oauthRoutes(): Hono<AppEnv> {
  return new Hono<AppEnv>();
}
