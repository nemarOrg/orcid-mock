// POST /oauth/token: the authorization_code, refresh_token, and client_credentials grants.
// Since April 2026 ORCID's registry proxies this endpoint to a new authorization server
// (ORCID's release notes, https://info.orcid.org/registry-release-notes/, and the proxy,
// https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-web/src/main/java/org/orcid/frontend/web/controllers/OauthGenericCallsController.java#L42-L50).
// The order of its checks is: form-encoded body, `grant_type` present, client authentication,
// then the grant itself (a `grant_type=password` request with an unknown client was observed to
// get `invalid_client` on sandbox.orcid.org on 2026-10-01).
import type { Context } from "hono";
import type { AppEnv } from "../app";
import { serverNowMs } from "../clock";
import { JSON_UTF8, tokenEndpointError } from "../errors";
import type { ScopeName, Store, StoredClient, TokenRecord } from "../store/types";
import { authenticateClient } from "./client-auth";
import { readForm } from "./form";
import { parseScopes, scopeTokens } from "./scopes";
import { buildTokenResponse, TOKEN_TTL_SECONDS, type TokenResponseInput } from "./token-response";

type Ctx = Context<AppEnv>;

/**
 * A fresh access and refresh token pair. `expires_at_ms` is server time, which includes the admin
 * clock offset: it is for validity checks only, and an emitted time such as an `id_token` `exp`
 * must come from wall time (`Date.now()`), never from it.
 */
async function newTokenRecord(
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
    // Lowercase UUID v4 strings, as ORCID's legacy implementation (removed upstream) issued:
    // https://github.com/ORCID/ORCID-Source/blob/7eeb1e7709760f328f5d3f72ebf2629f0a5d54c9/orcid-core/src/main/java/org/orcid/core/oauth/service/OrcidRandomValueTokenServicesImpl.java#L165
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
async function tokenJson(c: Ctx, input: Omit<TokenResponseInput, "deps">): Promise<Response> {
  const body = await buildTokenResponse({ deps: c.get("deps"), ...input });
  return c.json(body, 200, {
    "Content-Type": JSON_UTF8,
    "Cache-Control": "no-store",
    Pragma: "no-cache",
  });
}

export async function tokenEndpoint(c: Ctx): Promise<Response> {
  const form = await readForm(c);
  if (!form.ok) return form.response;
  const { params } = form;

  // Observed on sandbox.orcid.org on 2026-10-01: 400, `error` before `error_description`; the
  // registry builds it for a null `grant_type`:
  // https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-web/src/main/java/org/orcid/frontend/web/controllers/OauthGenericCallsController.java#L44-L50
  const grantType = params.get("grant_type");
  if (grantType === null || grantType === "") {
    return tokenEndpointError(c, 400, "unsupported_grant_type", "grant_type is missing");
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
      // orcid-mock choice: ORCID's answer to an unsupported grant from a valid client was not
      // observed, so this follows the shape of the missing-grant body above.
      return tokenEndpointError(
        c,
        400,
        "unsupported_grant_type",
        `Unsupported grant type: ${grantType}`,
      );
  }
}

async function authorizationCodeGrant(
  c: Ctx,
  client: StoredClient,
  params: URLSearchParams,
): Promise<Response> {
  const { store } = c.get("deps");
  const code = params.get("code");
  // orcid-mock choice: the registry forwards a blank code to the authorization server unchanged
  // (the `code` parameter becomes ""), so ORCID's own answer comes from the new server and was
  // not observed; a missing code is a 400 here, in the shape of the other missing parameters:
  // https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/oauth/authorizationServer/AuthorizationServerUtil.java#L55-L68
  if (code === null || code === "") {
    return tokenEndpointError(c, 400, "invalid_request", "code is required");
  }

  // The code is consumed whatever happens next, so a wrong client or redirect_uri cannot be
  // retried and a reused code is the unknown-code case (RFC 6749 section 4.1.2).
  const record = await store.consumeCode(code);
  const user = record ? await store.getUser(record.orcid) : null;
  if (!record || !user || (await serverNowMs(store)) >= record.expires_at_ms) {
    // ORCID's error documentation lists a 400 "Invalid authorization code: [code]"
    // (https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-api-web/tutorial/api_errors.md#L37); the `invalid_grant` error code is
    // orcid-mock's inference. A code that expired, was already used, or never existed all land
    // here, and so does a code whose user was deleted.
    return tokenEndpointError(c, 400, "invalid_grant", `Invalid authorization code: ${code}`);
  }
  if (record.client_id !== client.client_id || params.get("redirect_uri") !== record.redirect_uri) {
    // ORCID's error documentation lists this 400 text "when you provide invalid parameters
    // (client id, secret or redirect uri) on authorization code exchange"
    // (https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-api-web/tutorial/api_errors.md#L36); the `invalid_grant` error code is
    // orcid-mock's inference.
    return tokenEndpointError(
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
  return tokenJson(c, {
    grant: "authorization_code",
    token,
    user,
    amr: record.amr,
    nonce: record.nonce,
    auth_time_ms: record.auth_time_ms,
  });
}

async function refreshTokenGrant(
  c: Ctx,
  client: StoredClient,
  params: URLSearchParams,
): Promise<Response> {
  const { store } = c.get("deps");
  const refreshToken = params.get("refresh_token");
  if (refreshToken === null || refreshToken === "") {
    // The registry's `addToMapOrThrow` raises "refresh_token is required", which its controller
    // answers as a 401 (the same path was observed for `client_id` on 2026-10-01):
    // https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/oauth/authorizationServer/AuthorizationServerUtil.java#L307-L313
    return tokenEndpointError(c, 401, "invalid_request", "refresh_token is required");
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
    // orcid-mock choice: ORCID's body for a bad refresh token was not observed; this follows
    // the "Invalid authorization code: [code]" wording of its documented code-exchange error.
    return tokenEndpointError(c, 400, "invalid_grant", `Invalid refresh token: ${refreshToken}`);
  }

  // An empty or omitted `scope` copies the parent's; otherwise it must be a subset
  // (https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-api-web/tutorial/refresh_tokens.md#L28).
  // orcid-mock choice: a scope outside the original is a 400 `invalid_scope`, as RFC 6749 section
  // 5.2 says. The only 400 "Invalid scope" row in ORCID's error documentation is the `/webhook`
  // case (https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-api-web/tutorial/api_errors.md#L43), and ORCID's registry code maps
  // an invalid scope to a 401 (https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/oauth/OAuthErrorUtils.java#L23-L25).
  let scopes = old.scopes;
  const requested = params.get("scope");
  if (requested !== null && requested.trim() !== "") {
    // The message names every requested scope the parent lacks, unknown ones included, as asked.
    const outside = scopeTokens(requested).filter((t) => !(old.scopes as string[]).includes(t));
    if (outside.length > 0) {
      return tokenEndpointError(c, 400, "invalid_scope", `Invalid scope: ${outside.join(" ")}`);
    }
    scopes = parseScopes(requested).scopes;
  }
  // orcid-mock choice: a client the admin API has demoted since sign-in cannot carry
  // `/read-limited` into a new token, the same refusal authorize gives it (ADR 0009). It can
  // refresh by asking for a narrower `scope`.
  if (scopes.includes("/read-limited") && !client.member) {
    return tokenEndpointError(c, 400, "invalid_scope", "Invalid scope: /read-limited");
  }

  // The legacy implementation (removed upstream) defaulted `revoke_old` to true when absent and
  // read a present value with `Boolean.valueOf`, which is true only for "true" in any case:
  // https://github.com/ORCID/ORCID-Source/blob/7eeb1e7709760f328f5d3f72ebf2629f0a5d54c9/orcid-core/src/main/java/org/orcid/core/oauth/service/OrcidRandomValueTokenServicesImpl.java#L439
  // Whether the new authorization server still honors it is unknown: the registry's refresh
  // proxy does not forward `revoke_old`:
  // https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/oauth/authorizationServer/AuthorizationServerUtil.java#L94-L112
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
    return tokenEndpointError(c, 400, "invalid_grant", `Invalid refresh token: ${refreshToken}`);
  return tokenJson(c, {
    grant: "refresh_token",
    token: rotated,
    user,
    amr: null,
    nonce: old.nonce,
    auth_time_ms: old.auth_time_ms,
  });
}

async function clientCredentialsGrant(
  c: Ctx,
  client: StoredClient,
  params: URLSearchParams,
): Promise<Response> {
  const { store } = c.get("deps");
  // The only client-credentials scope the mock serves is `/read-public`, and asking for nothing
  // gets it (https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-api-web/tutorial/read_public.md). Any other scope is a 400
  // `invalid_scope`, an orcid-mock choice (see the refresh grant above).
  const requested = params.get("scope");
  if (requested !== null && requested.trim() !== "") {
    const outside = scopeTokens(requested).filter((t) => t !== "/read-public");
    if (outside.length > 0) {
      return tokenEndpointError(c, 400, "invalid_scope", `Invalid scope: ${outside.join(" ")}`);
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
  return tokenJson(c, {
    grant: "client_credentials",
    token,
    user: null,
    amr: null,
    nonce: null,
    auth_time_ms: null,
  });
}
