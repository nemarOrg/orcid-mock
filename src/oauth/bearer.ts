// Bearer-token resolution, shared by userinfo (phase 3) and the record API's `/read-limited`
// reads (phase 4). Phase 3 maps `none` and `invalid` to userinfo's own 403 shape; phase 4 answers
// `invalid` with `invalidTokenResponse`.
import type { Context } from "hono";
import type { AppEnv } from "../app";
import { serverNowMs } from "../clock";
import { oauthError } from "../errors";
import type { Store, TokenRecord } from "../store/types";

export type BearerResult =
  /** No `Authorization: Bearer` header, or a bearer header with nothing after the scheme. */
  | { kind: "none" }
  /** A token was presented but is unknown, revoked, expired, or not an access token. */
  | { kind: "invalid"; presented: string }
  | { kind: "ok"; token: TokenRecord };

/**
 * Reads `Authorization: Bearer <token>`: the scheme is case-insensitive and the token is trimmed,
 * as ORCID's userinfo controller strips the "Bearer" or "bearer" prefix and trims
 * (ORCID-Source orcid-web/.../OpenIDController.java, research 5.4). A header with another scheme
 * presents no bearer token. The token is good only if it is a stored access token that is not
 * revoked and not expired at server time (the admin clock counts); a refresh token is not one.
 */
export async function resolveBearer(c: Context<AppEnv>, store: Store): Promise<BearerResult> {
  const header = c.req.header("authorization");
  const match = header === undefined ? null : /^\s*bearer\s+(\S.*?)\s*$/i.exec(header);
  const presented = match?.[1];
  if (presented === undefined) return { kind: "none" };

  const token = await store.getAccessToken(presented);
  if (!token || token.revoked || (await serverNowMs(store)) >= token.expires_at_ms) {
    return { kind: "invalid", presented };
  }
  return { kind: "ok", token };
}

/**
 * The record API's answer to a bad bearer token: 401 `invalid_token` with the presented token
 * echoed in the description and no `WWW-Authenticate` header, observed on
 * pub.sandbox.orcid.org/v3.0 on 2026-10-01 (research 6; ORCID-Source orcid-api-common/.../
 * APIAuthenticationEntryPoint.java and OAuthErrorResponseHelper.java).
 */
export function invalidTokenResponse(c: Context<AppEnv>, presented: string): Response {
  return oauthError(c, 401, "invalid_token", `Invalid access token: ${presented}`);
}
