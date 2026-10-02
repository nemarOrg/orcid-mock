import { Hono } from "hono";
import type { AppEnv } from "../app";
import { authorizeGet, authorizePost } from "../oauth/authorize";
import { revokeEndpoint } from "../oauth/revoke";
import { tokenEndpoint } from "../oauth/token";

// ORCID's OAuth 2.0 endpoints: /authorize, /token, and /revoke.
export function oauthRoutes(): Hono<AppEnv> {
  const oauth = new Hono<AppEnv>();
  oauth.get("/authorize", authorizeGet);
  oauth.post("/authorize", authorizePost);
  // Any method: a GET is ORCID's 415 too (observed on sandbox.orcid.org on 2026-10-01), which the
  // handler answers.
  oauth.all("/token", tokenEndpoint);
  oauth.all("/revoke", revokeEndpoint);
  return oauth;
}
