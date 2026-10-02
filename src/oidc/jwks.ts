// GET /oauth/jwks: the public half of the signing key.
import type { Context } from "hono";
import type { AppEnv } from "../app";
import { NO_STORE } from "../headers";
import { corsHeaders, OIDC_JSON } from "./headers";
import { getSigningKey } from "./keys";

/**
 * Compact JSON with one key and no `alg` member, in this key order, which is how
 * https://orcid.org/oauth/jwks answered on 2026-10-01. ORCID's older documentation showed an
 * `alg` member, so the shape probably changed with its 2026 authorization server, though the
 * documentation example may only have been hand-written. The cache headers and the content type
 * are the captured ones.
 */
export async function jwksEndpoint(c: Context<AppEnv>): Promise<Response> {
  const key = await getSigningKey(c.get("deps").store);
  const { e, n } = key.public_jwk;
  // A stored key always has both; failing here beats publishing a key a client cannot use.
  if (e === undefined || n === undefined) {
    throw new Error(`the stored signing key ${key.kid} has no public exponent or modulus`);
  }
  const body = { keys: [{ kty: "RSA", e, use: "sig", kid: key.kid, n }] };
  return c.body(JSON.stringify(body), 200, {
    ...OIDC_JSON,
    ...NO_STORE,
    ...corsHeaders(c),
  });
}
