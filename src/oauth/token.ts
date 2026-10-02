// POST /oauth/token: the authorization_code, refresh_token, and client_credentials grants.
// Since April 2026 ORCID's registry proxies this endpoint to a new authorization server
// (research 0 and 2); the order of its checks is: form-encoded body, `grant_type` present, client
// authentication, then the grant itself.
import type { Context } from "hono";
import type { AppEnv } from "../app";
import { serverNowMs } from "../clock";
import { oauthError } from "../errors";
import type { ScopeName, Store, StoredClient, StoredUser, TokenRecord } from "../store/types";
import { authenticateClient } from "./client-auth";
import { readForm } from "./form";
import { parseScopes, scopeTokens } from "./scopes";
import { buildTokenResponse, type Grant, TOKEN_TTL_SECONDS } from "./token-response";

type Ctx = Context<AppEnv>;

/** A fresh access and refresh token pair, expiring twenty years from server time. */
export async function newTokenRecord(
  store: Store,
  init: {
    client: StoredClient;
    orcid: string | null;
    scopes: ScopeName[];
    authTimeMs: number | null;
    nonce: string | null;
  },
): Promise<TokenRecord> {
  return {
    // Lowercase UUID v4 strings, as ORCID's legacy server issued (research 2.2).
    access_token: crypto.randomUUID(),
    refresh_token: crypto.randomUUID(),
    client_id: init.client.client_id,
    orcid: init.orcid,
    scopes: init.scopes,
    member: init.client.member,
    // Emitted times are wall time; only the expiry, a validity check, uses the admin offset.
    issued_at_ms: Date.now(),
    expires_at_ms: (await serverNowMs(store)) + TOKEN_TTL_SECONDS * 1000,
    revoked: false,
    auth_time_ms: init.authTimeMs,
    nonce: init.nonce,
  };
}

/** A token response: the body from `buildTokenResponse`, uncacheable (RFC 6749 section 5.1). */
async function tokenJson(
  c: Ctx,
  grant: Grant,
  token: TokenRecord,
  user: StoredUser | null,
): Promise<Response> {
  const body = await buildTokenResponse({ deps: c.get("deps"), grant, token, user });
  return c.json(body, 200, { "Cache-Control": "no-store", Pragma: "no-cache" });
}

export async function tokenEndpoint(c: Ctx): Promise<Response> {
  const form = await readForm(c);
  if (!form.ok) return form.response;
  const { params } = form;

  // research 3, observed on sandbox.orcid.org on 2026-10-01: 400, `error` first.
  const grantType = params.get("grant_type");
  if (grantType === null || grantType === "") {
    return oauthError(c, 400, "unsupported_grant_type", "grant_type is missing");
  }

  const auth = await authenticateClient(c, params);
  if (!auth.ok) return auth.response;
  const { client } = auth;

  switch (grantType) {
    case "authorization_code":
      return authorizationCodeGrant(c, client, params);
    case "refresh_token":
      return refreshTokenGrant(c, client, params);
    case "client_credentials":
      return clientCredentialsGrant(c, client, params);
    default:
      // research 3: unobserved for a valid client; INFERRED from the missing-grant body.
      return oauthError(c, 400, "unsupported_grant_type", `Unsupported grant type: ${grantType}`);
  }
}

async function authorizationCodeGrant(
  c: Ctx,
  client: StoredClient,
  params: URLSearchParams,
): Promise<Response> {
  const { store } = c.get("deps");
  const code = params.get("code");
  if (code === null || code === "")
    return oauthError(c, 400, "invalid_request", "code is required");

  // The code is consumed whatever happens next, so a wrong client or redirect_uri cannot be
  // retried and a reused code is the unknown-code case (RFC 6749 section 4.1.2).
  const record = await store.consumeCode(code);
  const user = record ? await store.getUser(record.orcid) : null;
  if (!record || !user || (await serverNowMs(store)) >= record.expires_at_ms) {
    // research 3, ORCID-Source orcid-api-web/tutorial/api_errors.md (April 2026): 400 "Invalid
    // authorization code: [code]"; the `invalid_grant` code is INFERRED. A code that expired, was
    // already used, or never existed all land here; a code whose user was deleted does too.
    return oauthError(c, 400, "invalid_grant", `Invalid authorization code: ${code}`);
  }
  if (record.client_id !== client.client_id || params.get("redirect_uri") !== record.redirect_uri) {
    // research 3, api_errors.md: "One of the provided parameters is invalid, or, the provided
    // token/code is invalid or expired", for a wrong client id, secret, or redirect uri.
    return oauthError(
      c,
      400,
      "invalid_grant",
      "One of the provided parameters is invalid, or, the provided token/code is invalid or expired",
    );
  }

  const token = await newTokenRecord(store, {
    client,
    orcid: record.orcid,
    scopes: record.scopes,
    authTimeMs: record.auth_time_ms,
    nonce: record.nonce,
  });
  await store.putTokens(token);
  return tokenJson(c, "authorization_code", token, user);
}

async function refreshTokenGrant(
  c: Ctx,
  client: StoredClient,
  params: URLSearchParams,
): Promise<Response> {
  const { store } = c.get("deps");
  const refreshToken = params.get("refresh_token");
  if (refreshToken === null || refreshToken === "") {
    return oauthError(c, 401, "invalid_request", "refresh_token is required");
  }

  const old = await store.getRefreshToken(refreshToken);
  const user = old?.orcid ? await store.getUser(old.orcid) : null;
  if (
    !old ||
    old.revoked ||
    old.client_id !== client.client_id ||
    (old.orcid !== null && user === null) ||
    (await serverNowMs(store)) >= old.expires_at_ms
  ) {
    return oauthError(c, 400, "invalid_grant", `Invalid refresh token: ${refreshToken}`);
  }

  // An empty or omitted `scope` copies the parent's; otherwise it must be a subset (ORCID-Source
  // orcid-api-web/tutorial/refresh_tokens.md). The status is 400 as api_errors.md says, where the
  // legacy server answered 401 (research 3).
  let scopes = old.scopes;
  const requested = params.get("scope");
  if (requested !== null && requested.trim() !== "") {
    // The message names every requested scope the parent lacks, unknown ones included, as asked.
    const outside = scopeTokens(requested).filter((t) => !(old.scopes as string[]).includes(t));
    if (outside.length > 0) {
      return oauthError(c, 400, "invalid_scope", `Invalid scope: ${outside.join(" ")}`);
    }
    scopes = parseScopes(requested).scopes;
  }

  // Legacy `OrcidRandomValueTokenServicesImpl.refreshAccessToken` (ORCID-Source): `revoke_old`
  // defaults to true when absent, and a present value is `Boolean.valueOf`, which is true only
  // for "true" in any case. Whether the new authorization server still honors it is unknown
  // (research 2.3: the registry proxy does not forward it).
  const revokeParam = params.get("revoke_old");
  const revokeOld = revokeParam === null ? true : revokeParam.toLowerCase() === "true";

  const next = await newTokenRecord(store, {
    client,
    orcid: old.orcid,
    scopes,
    authTimeMs: old.auth_time_ms,
    nonce: old.nonce,
  });
  // Atomic: a second rotation of the same refresh token loses, as a reuse would.
  const rotated = await store.rotateRefresh(refreshToken, next, revokeOld);
  if (!rotated)
    return oauthError(c, 400, "invalid_grant", `Invalid refresh token: ${refreshToken}`);
  return tokenJson(c, "refresh_token", rotated, user);
}

async function clientCredentialsGrant(
  c: Ctx,
  client: StoredClient,
  params: URLSearchParams,
): Promise<Response> {
  const { store } = c.get("deps");
  // ORCID-Source orcid-api-web/tutorial/read_public.md: the only client-credentials scope the
  // mock serves is `/read-public`, and asking for nothing gets it.
  const requested = params.get("scope");
  if (requested !== null && requested.trim() !== "") {
    const outside = scopeTokens(requested).filter((t) => t !== "/read-public");
    if (outside.length > 0) {
      return oauthError(c, 400, "invalid_scope", `Invalid scope: ${outside.join(" ")}`);
    }
  }
  const token = await newTokenRecord(store, {
    client,
    orcid: null,
    scopes: ["/read-public"],
    authTimeMs: null,
    nonce: null,
  });
  await store.putTokens(token);
  return tokenJson(c, "client_credentials", token, null);
}
