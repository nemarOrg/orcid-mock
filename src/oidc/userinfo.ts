// GET and POST /oauth/userinfo: who the access token's user is.
import type { Context } from "hono";
import type { AppEnv } from "../app";
import { accountState } from "../oauth/account-state";
import { checkAccessToken, readBearerHeader } from "../oauth/bearer";
import { publicNameClaims } from "../oauth/display-name";
import type { StoredUser, TokenRecord } from "../store/types";
import { corsHeaders, NO_STORE, OIDC_JSON } from "./headers";

type Ctx = Context<AppEnv>;

/**
 * ORCID's single failure, for no token, an unknown or revoked or expired one, and one without a
 * scope for `/authenticate`: 403, with a hyphenated `error-description` key (the Java field is
 * annotated `@JsonProperty("error-description")`, unlike every other ORCID error body) and no
 * `WWW-Authenticate` header. Observed on sandbox.orcid.org on 2026-10-01 for a missing and for a
 * bad bearer token, over GET and POST, with this content type and cache header:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-web/src/main/java/org/orcid/frontend/web/controllers/OpenIDController.java#L151-L160
 * The CORS headers on it come from ORCID's cross-domain filter, which runs ahead of the
 * controller (see `corsHeaders`).
 */
function accessDenied(c: Ctx): Response {
  return c.json({ error: "access_denied", "error-description": "access_token is invalid" }, 403, {
    ...OIDC_JSON,
    ...NO_STORE,
    ...corsHeaders(c),
  });
}

/**
 * ORCID lets a token reach userinfo when one of its scopes "has" `/authenticate`, meaning that
 * scope's combined set contains it (`hasScope`, at the last link below). That holds for
 * `/authenticate` itself and for `openid`, and for no other scope this mock serves
 * (`/read-limited` and `/read-public` do not combine it):
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-web/src/main/java/org/orcid/frontend/web/controllers/OpenIDController.java#L124-L126
 * https://github.com/ORCID/orcid-model/blob/9592e2d3bde21a1edf703f26f8bc304448f886fb/src/main/java/org/orcid/jaxb/model/message/ScopePathType.java#L61
 * https://github.com/ORCID/orcid-model/blob/9592e2d3bde21a1edf703f26f8bc304448f886fb/src/main/java/org/orcid/jaxb/model/message/ScopePathType.java#L104
 * https://github.com/ORCID/orcid-model/blob/9592e2d3bde21a1edf703f26f8bc304448f886fb/src/main/java/org/orcid/jaxb/model/message/ScopePathType.java#L118
 * https://github.com/ORCID/orcid-model/blob/9592e2d3bde21a1edf703f26f8bc304448f886fb/src/main/java/org/orcid/jaxb/model/message/ScopePathType.java#L322-L324
 */
function canReadUserinfo(token: TokenRecord): boolean {
  return token.scopes.includes("/authenticate") || token.scopes.includes("openid");
}

/**
 * The `access_token` parameter of a POST, which is the first place ORCID looks
 * (`request.getParameter("access_token")`). A servlet's parameter set is the query string
 * followed by the body, and `getParameter` returns the first value, so a query-string token wins
 * over a form field; the body counts only when it is `application/x-www-form-urlencoded`
 * (Jakarta Servlet 6.0, section 3.1, "HTTP Protocol Parameters":
 * https://jakarta.ee/specifications/servlet/6.0/jakarta-servlet-spec-6.0; ORCID's web server is
 * Tomcat 10.1, the Servlet 6.0 implementation, as the 415 page captured on sandbox.orcid.org on
 * 2026-10-01 shows). A GET has no such parameter here: its handler reads the header alone. An
 * empty value is no token.
 */
async function parameterAccessToken(c: Ctx): Promise<string | null> {
  if (c.req.method !== "POST") return null;
  const mediaType = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
  const fromForm =
    mediaType === "application/x-www-form-urlencoded"
      ? new URLSearchParams(await c.req.text()).get("access_token")
      : null;
  const token = c.req.query("access_token") ?? fromForm;
  return token === "" ? null : token;
}

/**
 * The user behind the first token that works. ORCID's POST handler tries the parameter and, if
 * that gives no answer for any reason (absent, unknown, revoked, or without the scope), falls
 * through to the `Authorization` header, so a bad parameter does not hide a good header:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-web/src/main/java/org/orcid/frontend/web/controllers/OpenIDController.java#L93-L105
 * GET reads the header alone.
 * orcid-mock choice: a token whose user has been deleted, locked, or deactivated is as invalid as
 * an unknown one (ADR 0009).
 */
async function userForRequest(c: Ctx): Promise<StoredUser | null> {
  const { store } = c.get("deps");
  for (const presented of [await parameterAccessToken(c), readBearerHeader(c)]) {
    if (presented === null) continue;
    const checked = await checkAccessToken(store, presented);
    if (checked.kind !== "ok" || !canReadUserinfo(checked.token) || checked.token.orcid === null) {
      continue;
    }
    const user = await store.getUser(checked.token.orcid);
    if (user !== null && accountState(user) === null) return user;
  }
  return null;
}

/**
 * `id` (the iD under the public base URL), `sub` (the bare iD), then `name`, `family_name`, and
 * `given_name`, which Jackson writes as `null` when the name is not public or the field does not
 * exist, since only ORCID's error subclass is annotated to skip nulls:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/oauth/openid/OpenIDConnectUserInfo.java#L8-L32
 * That the live success body includes `id` and the nulls is inferred from the source: no
 * success response was captured without a registered client.
 */
export async function userinfoEndpoint(c: Ctx): Promise<Response> {
  const user = await userForRequest(c);
  if (user === null) return accessDenied(c);
  const names = publicNameClaims(user);
  return c.json(
    {
      id: `${c.get("deps").config.publicBaseUrl}/${user.orcid}`,
      sub: user.orcid,
      name: names.name,
      family_name: names.family_name,
      given_name: names.given_name,
    },
    200,
    { ...OIDC_JSON, ...corsHeaders(c) },
  );
}
