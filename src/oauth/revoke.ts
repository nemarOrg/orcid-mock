// POST /oauth/revoke: revoke an access token or a refresh token, and with it the pair.
import type { Context } from "hono";
import type { AppEnv } from "../app";
import { tokenEndpointError } from "../errors";
import { authenticateClient } from "./client-auth";
import { readForm } from "./form";

/**
 * Form-encoded only (ORCID-Source orcid-web/.../oauth2/RevokeController.java: `consumes =
 * APPLICATION_FORM_URLENCODED`), with the token endpoint's client authentication; the token may
 * be an access token or a refresh token, and revoking either removes both (ORCID-Source
 * orcid-api-web/tutorial/revoke.md). Success is a 200 with an empty body (revoke.md shows only
 * the status line).
 * The rest is ORCID behavior nobody has observed, so each case is an orcid-mock choice:
 * - a missing `token` is 400 `invalid_request`; RevokeController throws "Please provide the
 *   token to be param" before it forwards anything, so this is checked before the client, and
 *   its status and body are unobserved;
 * - an unknown token is a 200, as RFC 7009 section 2.2 requires;
 * - a token issued to another client is 400 `unauthorized_client`, as RFC 7009 section 2.1
 *   describes, and is left alone.
 */
export async function revokeEndpoint(c: Context<AppEnv>): Promise<Response> {
  const form = await readForm(c);
  if (!form.ok) return form.response;

  const token = form.params.get("token");
  if (token === null || token === "") {
    return tokenEndpointError(c, 400, "invalid_request", "token is required");
  }
  const auth = await authenticateClient(c, form.params);
  if (!auth.ok) return auth.response;

  const { store } = c.get("deps");
  const record = (await store.getAccessToken(token)) ?? (await store.getRefreshToken(token));
  if (record === null) return c.body(null, 200);
  if (record.client_id !== auth.client.client_id) {
    return tokenEndpointError(c, 400, "unauthorized_client", "Token was not issued to this client");
  }
  await store.revoke(token);
  return c.body(null, 200);
}
