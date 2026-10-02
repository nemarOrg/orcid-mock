// The JSON body of a successful token response. One function builds it for every grant, so an
// `id_token` is added in exactly one place.
import type { AppDeps } from "../app";
import { signIdToken } from "../oidc/id-token";
import type { StoredUser, TokenRecord } from "../store/types";
import { publicDisplayName } from "./display-name";
import { formatScopes } from "./scopes";

/**
 * Access tokens last about twenty years ("Access tokens are long lived by default and expire 20
 * years after issue",
 * https://info.orcid.org/documentation/api-tutorials/api-tutorial-get-and-authenticated-orcid-id/).
 * The legacy implementation (removed upstream) configured 631138519 seconds, and ORCID's
 * examples report one second less, 631138518:
 * https://github.com/ORCID/ORCID-Source/blob/7eeb1e7709760f328f5d3f72ebf2629f0a5d54c9/orcid-core/src/main/java/org/orcid/core/oauth/service/OrcidRandomValueTokenServicesImpl.java#L67
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-api-web/tutorial/get_id.md#L64
 */
export const TOKEN_TTL_SECONDS = 631138519;
export const EXPIRES_IN_SECONDS = 631138518;

export type Grant = "authorization_code" | "refresh_token" | "client_credentials";

export interface TokenResponseInput {
  deps: AppDeps;
  grant: Grant;
  token: TokenRecord;
  /** The signed-in user, or null for a client-credentials token. */
  user: StoredUser | null;
  /**
   * What an ID token needs and the token record does not carry: `amr` is stored on the
   * authorization code, so only the authorization-code grant has one; `nonce` and `auth_time_ms`
   * come from the consumed code there, and from the parent token on a refresh.
   */
  amr: string | null;
  nonce: string | null;
  auth_time_ms: number | null;
}

/** The response body, keys in the order they are written; `id_token`, when present, is last. */
export interface TokenResponseBody {
  access_token: string;
  token_type: "bearer";
  refresh_token: string;
  expires_in: number;
  scope: string;
  /** Absent for a client-credentials token. */
  name?: string;
  orcid: string | null;
  id_token?: string;
}

/**
 * Keys in ORCID's documented order: `access_token`, `token_type` ("bearer"), `refresh_token`,
 * `expires_in`, `scope`, then `name` (the public display name, "" when the name is not public)
 * and `orcid`:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-api-web/README.md#L97-L99
 * ORCID's own tutorial writes `orcid` before `name` in one example
 * (https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-api-web/tutorial/get_id.md#L65-L66),
 * so the order of those two keys is not settled upstream; orcid-mock follows the README.
 * A client-credentials token has no user: `orcid` is an explicit `null` and there is no `name`
 * key:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-api-web/tutorial/read_public.md#L29
 *
 * This is the one place an `id_token` is added: last, after `orcid`, when the grant is
 * "authorization_code" and the token's scopes include `openid`. The refresh path and client
 * credentials carry none (ORCID's legacy implementation, removed upstream, added it only when
 * the scope held `openid` and did not add it on refresh:
 * https://github.com/ORCID/ORCID-Source/blob/7eeb1e7709760f328f5d3f72ebf2629f0a5d54c9/orcid-core/src/main/java/org/orcid/core/oauth/openid/OpenIDConnectTokenEnhancer.java#L66-L71
 * and the token-response example with `openid` puts `id_token` after `orcid`:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-web/ORCID_AUTH_WITH_OPENID_CONNECT.md#L45).
 * `input.deps` is here for the store and the public base URL.
 */
export async function buildTokenResponse(input: TokenResponseInput): Promise<TokenResponseBody> {
  const { token, user } = input;
  const common = {
    access_token: token.access_token,
    token_type: "bearer" as const,
    refresh_token: token.refresh_token,
    expires_in: EXPIRES_IN_SECONDS,
    scope: formatScopes(token.scopes),
  };
  if (user === null) return { ...common, orcid: null };
  const body = { ...common, name: publicDisplayName(user), orcid: user.orcid };
  if (input.grant !== "authorization_code" || !token.scopes.includes("openid")) return body;
  const id_token = await signIdToken({
    store: input.deps.store,
    issuer: input.deps.config.publicBaseUrl,
    clientId: token.client_id,
    user,
    accessToken: token.access_token,
    authTimeMs: input.auth_time_ms,
    amr: input.amr,
    nonce: input.nonce,
  });
  return { ...body, id_token };
}
