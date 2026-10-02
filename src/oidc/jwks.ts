// GET /oauth/jwks: the public half of the signing key.
import type { Context } from "hono";
import type { AppEnv } from "../app";
import { corsHeaders, NO_STORE, OIDC_JSON } from "./headers";
import { getSigningKey } from "./keys";

/**
 * Compact JSON with one key and no `alg` member, in this key order, which is how
 * https://orcid.org/oauth/jwks answered on 2026-10-01 (ORCID's older documentation showed `alg`,
 * so the shape changed with its 2026 authorization server). The cache headers are the observed
 * ones. The content type is the one ORCID's other OpenID Connect routes use; it was not captured
 * for this route.
 */
export async function jwksEndpoint(c: Context<AppEnv>): Promise<Response> {
  const key = await getSigningKey(c.get("deps").store);
  const { e, n } = key.public_jwk;
  const body = { keys: [{ kty: "RSA", e, use: "sig", kid: key.kid, n }] };
  return c.body(JSON.stringify(body), 200, {
    ...OIDC_JSON,
    ...NO_STORE,
    Pragma: "no-cache",
    ...corsHeaders(c),
  });
}
