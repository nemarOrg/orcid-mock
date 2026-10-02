import { Hono } from "hono";
import type { AppEnv } from "../app";
import { authorizeGet, authorizePost } from "../oauth/authorize";
import { revokeEndpoint } from "../oauth/revoke";
import { tokenEndpoint } from "../oauth/token";

// ORCID's OAuth 2.0 endpoints. Phase 2 (#5): /authorize, /token, /revoke.
export function oauthRoutes(): Hono<AppEnv> {
  const oauth = new Hono<AppEnv>();
  oauth.get("/authorize", authorizeGet);
  oauth.post("/authorize", authorizePost);
  // Any method: a GET is ORCID's 415 too (research 2.1), which the handler answers.
  oauth.all("/token", tokenEndpoint);
  oauth.all("/revoke", revokeEndpoint);
  return oauth;
}
