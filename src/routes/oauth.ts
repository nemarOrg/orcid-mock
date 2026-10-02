import { Hono } from "hono";
import type { AppEnv } from "../app";
import { authorizeGet, authorizePost } from "../oauth/authorize";

// ORCID's OAuth 2.0 endpoints. Phase 2 (#5): /authorize, /token, /revoke.
export function oauthRoutes(): Hono<AppEnv> {
  const oauth = new Hono<AppEnv>();
  oauth.get("/authorize", authorizeGet);
  oauth.post("/authorize", authorizePost);
  return oauth;
}
