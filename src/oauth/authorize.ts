// GET and POST /oauth/authorize: the authorization-code flow's front door.
// Real ORCID serves a single-page app on this URL, so what a client observes is the sequence of
// calls the app makes to ORCID's authorization server: it reads the request, asks the server to
// validate it (an unknown client or a missing parameter is a 400 with a JSON body), and either
// navigates the browser to the client's redirect URI or shows its own error page. This module
// reproduces the outcomes (a code redirect, an error redirect, or an error body) in one request.
// Observed on auth.sandbox.orcid.org/oauth2/authorize on 2026-10-01.
import type { Context } from "hono";
import type { AppEnv } from "../app";
import { JSON_LATIN1, oauthError } from "../errors";
import type { ScopeName, StoredClient, StoredUser } from "../store/types";
import { type Checked, fail } from "./checked";
import { issueCode } from "./codes";
import { renderConsentPage } from "./consent-page";
import { readForm } from "./form";
import { redirectUriMatches, withFragment, withQuery } from "./redirect-uri";
import { parseScopes } from "./scopes";
import { currentSession, startSession } from "./session";

type Ctx = Context<AppEnv>;

/** A request that passed ORCID's up-front checks: a known client, a registered redirect URI. */
interface AuthorizeRequest {
  params: URLSearchParams;
  client: StoredClient;
  /** Exactly as the client sent it. */
  redirectUri: string;
  scopes: ScopeName[];
  state: string | null;
  nonce: string | null;
}

/** The 400 JSON errors the authorization server was observed to send, in its content type. */
function authorizeError(
  c: Ctx,
  error: string,
  description: string,
  descriptionFirst: boolean,
): Response {
  return oauthError(c, 400, error, description, { descriptionFirst, contentType: JSON_LATIN1 });
}

/**
 * The up-front checks, shared by the GET and the consent POST.
 * Real ORCID answers the first ones with no redirect, because it cannot trust the `redirect_uri`
 * of an unknown client or a mismatch; the rest it hands back to the client app.
 */
async function checkRequest(
  c: Ctx,
  params: URLSearchParams,
): Promise<Checked<{ request: AuthorizeRequest }>> {
  const { store } = c.get("deps");

  // Observed on auth.sandbox.orcid.org/oauth2/authorize on 2026-10-01: HTTP 400, content type
  // `application/json;charset=ISO-8859-1`, `error_description` before `error`, code
  // `invalid_request` (not `invalid_client`). An empty query reported `response_type` first, and a
  // query with everything but the client reported the client, so a missing `response_type` is
  // checked before a missing `client_id`. The order of the other missing parameters was not
  // observed; orcid-mock checks them in the order below.
  const responseType = params.get("response_type");
  if (responseType === null || responseType === "") {
    return fail(authorizeError(c, "invalid_request", "Missing parameter: response_type", true));
  }
  const clientId = params.get("client_id");
  if (clientId === null || clientId === "") {
    return fail(
      authorizeError(c, "invalid_request", "Missing parameter: client_id is missing", true),
    );
  }
  const client = await store.getClient(clientId);
  if (!client) {
    return fail(authorizeError(c, "invalid_request", "Invalid parameter: client_id", true));
  }

  // ORCID never redirects to an unverified redirect_uri. The current server's body for a mismatch
  // is unobserved, so orcid-mock keeps the text of the legacy implementation (removed upstream):
  // https://github.com/ORCID/ORCID-Source/blob/7eeb1e7709760f328f5d3f72ebf2629f0a5d54c9/orcid-web/src/main/java/org/orcid/frontend/oauth2/OauthController.java#L442-L447
  const redirectUri = params.get("redirect_uri");
  if (!redirectUri || !redirectUriMatches(redirectUri, client.redirect_uris)) {
    return fail(
      authorizeError(
        c,
        "invalid_grant",
        "Redirect URI doesn't match your registered redirect URIs.",
        false,
      ),
    );
  }

  // The current ORCID front end hands these errors back to the client app as a fragment with no
  // description and no state, `${redirectUrl}#error=${error}`; `unsupported_response_type` and
  // `invalid_scope` are among the codes it treats as the client application's to handle:
  // https://github.com/ORCID/orcid-angular/blob/005a02798b4b5e04aedf51b88087bedc783201d3/src/app/core/oauth/oauth.service.ts#L42-L47
  // https://github.com/ORCID/orcid-angular/blob/005a02798b4b5e04aedf51b88087bedc783201d3/src/app/core/oauth/oauth.service.ts#L267-L270
  if (responseType !== "code") {
    return fail(errorRedirect(c, redirectUri, "unsupported_response_type"));
  }
  const { scopes, unknown } = parseScopes(params.get("scope"));
  if (
    scopes.length === 0 ||
    unknown.length > 0 ||
    // `/read-public` is a client-credentials scope; `/read-limited` needs a member client, and
    // ORCID documents the failure as a redirect ("302 Invalid scope", for example that a
    // `/read-limited` scope cannot be used with a public client):
    // https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-api-web/tutorial/api_errors.md#L35
    scopes.includes("/read-public") ||
    (scopes.includes("/read-limited") && !client.member)
  ) {
    return fail(errorRedirect(c, redirectUri, "invalid_scope"));
  }

  return {
    ok: true,
    request: {
      params,
      client,
      redirectUri,
      scopes,
      state: params.get("state"),
      nonce: params.get("nonce") || null,
    },
  };
}

function errorRedirect(c: Ctx, redirectUri: string, error: string): Response {
  return c.redirect(withFragment(redirectUri, `error=${error}`), 302);
}

/** Why a user may not sign in, or null: orcid-mock choice, real ORCID refuses these sign-ins. */
function refusal(user: StoredUser, param: string): string | null {
  if (user.deactivated) return `${param} iD ${user.orcid} is deactivated and cannot sign in`;
  if (user.locked) return `${param} iD ${user.orcid} is locked and cannot sign in`;
  return null;
}

/** The user a `login_as` or consent-form `orcid` names, or the 400 that says why not. */
async function signInTarget(
  c: Ctx,
  orcid: string | null,
  param: "login_as" | "orcid",
): Promise<Checked<{ user: StoredUser }>> {
  const { store } = c.get("deps");
  if (orcid === null || orcid === "") {
    return fail(oauthError(c, 400, "invalid_request", `Missing parameter: ${param}`));
  }
  const user = await store.getUser(orcid);
  if (!user) {
    return fail(oauthError(c, 400, "invalid_request", `Unknown ${param} iD: ${orcid}`));
  }
  const why = refusal(user, param);
  if (why !== null) return fail(oauthError(c, 400, "invalid_request", why));
  return { ok: true, user };
}

/** Redirects to the client with a fresh code for `user`, signed in at `authTimeMs`. */
async function redirectWithCode(
  c: Ctx,
  request: AuthorizeRequest,
  user: StoredUser,
  authTimeMs: number,
): Promise<Response> {
  const code = await issueCode(c.get("deps").store, {
    client: request.client,
    orcid: user.orcid,
    scopes: request.scopes,
    redirectUri: request.redirectUri,
    nonce: request.nonce,
    authTimeMs,
  });
  return c.redirect(codeRedirect(request, code), 302);
}

/** Signs the user in (session cookie) and redirects to the client with a fresh code. */
async function completeSignIn(c: Ctx, request: AuthorizeRequest, user: StoredUser) {
  const authTimeMs = Date.now();
  await startSession(c, user.orcid, authTimeMs);
  return redirectWithCode(c, request, user, authTimeMs);
}

/**
 * `prompt=none`: no page and no sign-in form. With a live session the user gets a code at once
 * (in the current front end, `prompt=none` with a logged-in user and the `openid` scope navigates
 * straight to the redirect URL:
 * https://github.com/ORCID/orcid-angular/blob/005a02798b4b5e04aedf51b88087bedc783201d3/src/app/core/auth-decision/auth-decision.service.ts#L224-L240);
 * without one the browser goes back to the client with `login_required`.
 * Two forms exist and the source wins over the documentation. The current front end redirects to
 * `${redirect_uri}#login_required`, a fragment with no `error=` key and no state:
 * https://github.com/ORCID/orcid-angular/blob/005a02798b4b5e04aedf51b88087bedc783201d3/src/app/guards/authorize.guard.ts#L115-L127
 * while ORCID's OpenID Connect guide says the browser returns "with an error as a query string
 * parameter":
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-web/ORCID_AUTH_WITH_OPENID_CONNECT.md#L96
 * A session whose user was deleted, locked, or deactivated since counts as no session.
 */
async function silentSignIn(c: Ctx, request: AuthorizeRequest): Promise<Response> {
  const session = await currentSession(c);
  const user = session ? await c.get("deps").store.getUser(session.orcid) : null;
  if (session && user && refusal(user, "session") === null) {
    // The code carries the time of the sign-in the session records, not the time of this request.
    return redirectWithCode(c, request, user, session.auth_time_ms);
  }
  return c.redirect(withFragment(request.redirectUri, "login_required"), 302);
}

/** The redirect URI with `code` and the `state` exactly as received, each encoded once. */
function codeRedirect(request: AuthorizeRequest, code: string): string {
  const pairs: Array<[string, string]> = [["code", code]];
  if (request.state !== null) pairs.push(["state", request.state]);
  return withQuery(request.redirectUri, pairs);
}

export async function authorizeGet(c: Ctx): Promise<Response> {
  const { store, config } = c.get("deps");
  const checked = await checkRequest(c, new URL(c.req.url).searchParams);
  if (!checked.ok) return checked.response;
  const { request } = checked;

  // `prompt` is honored only on requests that include the `openid` scope (ORCID's OpenID Connect
  // guide, "Supports the 'prompt' and 'nonce' parameters for authorisation requests that include
  // the 'openid' scope", and the front end's `prompt === 'login' && isOpenId`):
  // https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-web/ORCID_AUTH_WITH_OPENID_CONNECT.md#L18
  // https://github.com/ORCID/orcid-angular/blob/005a02798b4b5e04aedf51b88087bedc783201d3/src/app/core/auth-decision/auth-decision.service.ts#L113-L114
  // `prompt=login` needs no code of its own: a session never signs anyone in except under
  // `prompt=none`, so the page below is what a forced re-login looks like.
  // orcid-mock choice: `login_as` is ignored under `prompt=none`, which takes the session's user.
  if (request.scopes.includes("openid") && request.params.get("prompt") === "none") {
    return silentSignIn(c, request);
  }

  // orcid-mock extension for headless drivers: sign in as the named user without the page.
  const loginAs = request.params.get("login_as");
  if (loginAs !== null && loginAs !== "") {
    const target = await signInTarget(c, loginAs, "login_as");
    if (!target.ok) return target.response;
    return completeSignIn(c, request, target.user);
  }

  const html = renderConsentPage({
    action: `${config.publicBaseUrl}/oauth/authorize`,
    client: request.client,
    scopes: request.scopes,
    users: await store.listUsers(),
    params: request.params,
  });
  return c.body(html, 200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    // No script and no external asset; a form's own redirect target is left unrestricted, since
    // some browsers apply `form-action` to the redirect that follows a submission.
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
  });
}

/**
 * The consent page's submission. The page carries the original query parameters as hidden
 * fields, so the same up-front checks run again before anything is issued.
 */
export async function authorizePost(c: Ctx): Promise<Response> {
  const form = await readForm(c);
  if (!form.ok) return form.response;
  const checked = await checkRequest(c, form.params);
  if (!checked.ok) return checked.response;
  const { request } = checked;

  if (form.params.get("action") === "deny") {
    // The legacy implementation (removed upstream) denied by redirecting to the redirect URI with
    // `?error=access_denied&error_description=User denied access` and the state, `&` instead of
    // `?` when the URI already had a query:
    // https://github.com/ORCID/ORCID-Source/blob/7eeb1e7709760f328f5d3f72ebf2629f0a5d54c9/orcid-web/src/main/java/org/orcid/frontend/web/controllers/OauthControllerBase.java#L114-L120
    const pairs: Array<[string, string]> = [
      ["error", "access_denied"],
      ["error_description", "User denied access"],
    ];
    if (request.state !== null) pairs.push(["state", request.state]);
    return c.redirect(withQuery(request.redirectUri, pairs), 302);
  }

  const target = await signInTarget(c, form.params.get("orcid"), "orcid");
  if (!target.ok) return target.response;
  return completeSignIn(c, request, target.user);
}
