// GET and POST /oauth/authorize: the authorization-code flow's front door.
// Real ORCID serves a single-page app on this URL, so what a client observes is the sequence of
// calls the SPA makes to ORCID's authorization server (research 1); this module reproduces the
// outcomes (a code redirect, an error redirect, or an error body) in one request.
import type { Context } from "hono";
import type { AppEnv } from "../app";
import { oauthError } from "../errors";
import type { ScopeName, StoredClient, StoredUser } from "../store/types";
import { issueCode } from "./codes";
import { renderConsentPage } from "./consent-page";
import { readForm } from "./form";
import { redirectUriMatches, withFragment, withQuery } from "./redirect-uri";
import { parseScopes } from "./scopes";
import { startSession } from "./session";

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

type Checked = { ok: true; request: AuthorizeRequest } | { ok: false; response: Response };

const reject = (response: Response): Checked => ({ ok: false, response });

/**
 * Steps 1 to 3 of the authorize validation, shared by the GET and the consent POST.
 * Real ORCID answers the first two with no redirect, because it cannot trust the `redirect_uri`
 * of an unknown client or a mismatch; the rest it hands back to the client app.
 */
async function checkRequest(c: Ctx, params: URLSearchParams): Promise<Checked> {
  const { store } = c.get("deps");

  // research 1.2 and 1.4, observed on auth.sandbox.orcid.org/oauth2/authorize on 2026-10-01:
  // 400 with `error_description` before `error`, and `invalid_request` rather than `invalid_client`.
  const clientId = params.get("client_id");
  if (clientId === null || clientId === "") {
    return reject(
      oauthError(c, 400, "invalid_request", "Missing parameter: client_id is missing", {
        descriptionFirst: true,
      }),
    );
  }
  const client = await store.getClient(clientId);
  if (!client) {
    return reject(
      oauthError(c, 400, "invalid_request", "Invalid parameter: client_id", {
        descriptionFirst: true,
      }),
    );
  }

  // research 1.4: ORCID never redirects to an unverified redirect_uri; the legacy OauthController
  // answered `invalid_grant` with this text (ORCID-Source orcid-web/.../oauth2/OauthController.java).
  // The current server's body is unobserved, so the legacy text is kept.
  const redirectUri = params.get("redirect_uri");
  if (!redirectUri || !redirectUriMatches(redirectUri, client.redirect_uris)) {
    return reject(
      oauthError(
        c,
        400,
        "invalid_grant",
        "Redirect URI doesn't match your registered redirect URIs.",
      ),
    );
  }

  // research 1.4: the current ORCID front end hands these two back to the client app as a
  // fragment with no description and no state (orcid-angular src/app/core/oauth/oauth.service.ts,
  // OAUTH_SESSION_ERROR_CODES_HANDLE_BY_CLIENT_APP: `${redirectUrl}#error=${error}`).
  if (params.get("response_type") !== "code") {
    return reject(errorRedirect(c, redirectUri, "unsupported_response_type"));
  }
  const { scopes, unknown } = parseScopes(params.get("scope"));
  if (
    scopes.length === 0 ||
    unknown.length > 0 ||
    // `/read-public` is a client-credentials scope; `/read-limited` needs a member client
    // (ORCID-Source orcid-api-web/tutorial/api_errors.md: "302 Invalid scope").
    scopes.includes("/read-public") ||
    (scopes.includes("/read-limited") && !client.member)
  ) {
    return reject(errorRedirect(c, redirectUri, "invalid_scope"));
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
): Promise<{ ok: true; user: StoredUser } | { ok: false; response: Response }> {
  const { store } = c.get("deps");
  if (orcid === null || orcid === "") {
    return {
      ok: false,
      response: oauthError(c, 400, "invalid_request", `Missing parameter: ${param}`),
    };
  }
  const user = await store.getUser(orcid);
  if (!user) {
    return {
      ok: false,
      response: oauthError(c, 400, "invalid_request", `Unknown ${param} iD: ${orcid}`),
    };
  }
  const why = refusal(user, param);
  if (why !== null) return { ok: false, response: oauthError(c, 400, "invalid_request", why) };
  return { ok: true, user };
}

/** Signs the user in (session cookie) and redirects to the client with a fresh code. */
async function completeSignIn(c: Ctx, request: AuthorizeRequest, user: StoredUser) {
  const { store } = c.get("deps");
  const authTimeMs = Date.now();
  await startSession(c, user.orcid, authTimeMs);
  const code = await issueCode(store, {
    client: request.client,
    orcid: user.orcid,
    scopes: request.scopes,
    redirectUri: request.redirectUri,
    nonce: request.nonce,
    authTimeMs,
  });
  return c.redirect(codeRedirect(request, code), 302);
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
    // research 1.4, legacy OauthControllerBase.buildDenyRedirectUri (ORCID-Source
    // orcid-web/.../oauth2/OauthControllerBase.java): the redirect URI with
    // `?error=access_denied&error_description=User denied access` and the state.
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
