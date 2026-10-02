// Bearer-token resolution, shared by the OpenID Connect userinfo endpoint and the record API's
// `/read-limited` reads. Userinfo maps `none` and `invalid` to its own 403 shape; the record API
// answers `invalid` with `invalidTokenResponse`.
import type { Context } from "hono";
import type { AppEnv } from "../app";
import { serverNowMs } from "../clock";
import { JSON_UTF8, oauthError } from "../errors";
import type { Store, TokenRecord } from "../store/types";

export type BearerResult =
  /** No `Authorization: Bearer` header, or a bearer header with nothing after the scheme. */
  | { kind: "none" }
  /** A token was presented but is unknown, revoked, expired, or not an access token. */
  | { kind: "invalid"; presented: string }
  | { kind: "ok"; token: TokenRecord };

/** A token that was presented, which `checkAccessToken` judges. */
export type CheckedAccessToken = Exclude<BearerResult, { kind: "none" }>;

/**
 * The one rule for whether a presented token is good: it is a stored access token (a refresh
 * token is not one) that is not revoked and not expired at server time, the admin clock
 * included. Callers that find the token somewhere other than the header, such as a form field or
 * an `access_token` query parameter, call this directly.
 */
export async function checkAccessToken(
  store: Store,
  presented: string,
): Promise<CheckedAccessToken> {
  const token = await store.getAccessToken(presented);
  if (!token || token.revoked || (await serverNowMs(store)) >= token.expires_at_ms) {
    return { kind: "invalid", presented };
  }
  return { kind: "ok", token };
}

/**
 * The token in `Authorization: Bearer <token>`, or null when there is none. The scheme is
 * case-insensitive and the token is trimmed, as ORCID's userinfo controller strips the "Bearer"
 * or "bearer" prefix and trims:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-web/src/main/java/org/orcid/frontend/web/controllers/OpenIDController.java#L82
 * A header
 * with another scheme, or a scheme with nothing after it, presents no bearer token.
 */
export function readBearerHeader(c: Context<AppEnv>): string | null {
  const header = c.req.header("authorization");
  const match = header === undefined ? null : /^\s*bearer\s+(\S.*?)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

/** The header route: `none` without a bearer header, else `checkAccessToken` on what it holds. */
export async function resolveBearer(c: Context<AppEnv>, store: Store): Promise<BearerResult> {
  const presented = readBearerHeader(c);
  return presented === null ? { kind: "none" } : checkAccessToken(store, presented);
}

/**
 * The record API's answer to a bad bearer token: 401 `invalid_token` with the presented token
 * echoed in the description and no `WWW-Authenticate` header, observed on
 * pub.sandbox.orcid.org/v3.0 on 2026-10-01. ORCID builds it in its authentication entry point,
 * with `application/json;charset=UTF-8`, an `error` then an `error_description` key, and the
 * presented token appended to "Invalid access token":
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-api-common/src/main/java/org/orcid/api/common/security/oauth/APIAuthenticationEntryPoint.java#L38-L47
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-api-common/src/main/java/org/orcid/api/common/security/oauth/OAuthErrorResponseHelper.java#L14-L16
 */
export function invalidTokenResponse(c: Context<AppEnv>, presented: string): Response {
  return oauthError(c, 401, "invalid_token", `Invalid access token: ${presented}`, {
    contentType: JSON_UTF8,
  });
}
