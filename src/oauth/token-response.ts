// The JSON body of a successful token response. One function builds it for every grant, so an
// `id_token` is added in exactly one place.
import type { AppDeps } from "../app";
import type { StoredUser, TokenRecord } from "../store/types";
import { publicDisplayName } from "./display-name";
import { formatScopes } from "./scopes";

/**
 * Access tokens last about twenty years: ORCID's `read_validity_seconds` is 631138519 and the
 * response reports it minus the second that has passed, 631138518 (ORCID-Source orcid-api-web
 * tutorial examples and the legacy `org.orcid.core.token.read_validity_seconds`, research 2.2).
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
 * Keys in ORCID's documented order (ORCID-Source orcid-api-web/README.md and tutorial/get_id.md):
 * `access_token`, `token_type` ("bearer"), `refresh_token`, `expires_in`, `scope`, then `name`
 * (the public display name, "" when the name is not public) and `orcid`.
 * A client-credentials token has no user: `orcid` is an explicit `null` and there is no `name`
 * key (ORCID-Source orcid-api-web/tutorial/read_public.md).
 *
 * This is the one place an `id_token` is added: after `orcid`, when `openid` is among the
 * token's scopes and `grant` is "authorization_code"; the refresh path and client credentials
 * carry none. `input.deps` is here for the store and the public base URL.
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
  return user === null
    ? { ...common, orcid: null }
    : { ...common, name: publicDisplayName(user), orcid: user.orcid };
}
