// The ID token that an authorization-code exchange with the `openid` scope returns.
import { base64url, SignJWT } from "jose";
import { publicNameClaims } from "../oauth/display-name";
import type { Store, StoredUser } from "../store/types";
import { getSigningKey, importSigningKey } from "./keys";

/**
 * An ID token lasts 24 hours. This is an orcid-mock choice, because ORCID's own sources
 * disagree. Decoded, the ID token in its 2017 token-response example expires 600 seconds after
 * it was issued:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-web/ORCID_AUTH_WITH_OPENID_CONNECT.md#L45
 * the one in its 2019 token-delegation example expires after 631138519 seconds, about twenty
 * years, as long as an access token lives:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-api-web/tutorial/token_delegation.md#L42
 * and the claim set that its 2020 text prints, and the legacy implementation (removed upstream),
 * give 24 hours:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-web/ORCID_AUTH_WITH_OPENID_CONNECT.md#L89
 * https://github.com/ORCID/ORCID-Source/blob/7eeb1e7709760f328f5d3f72ebf2629f0a5d54c9/orcid-core/src/main/java/org/orcid/core/oauth/openid/OpenIDConnectTokenEnhancer.java#L98-L103
 * What the 2026 authorization server issues was not observed. A day outlasts any test run, so a
 * client's own expiry check never fails mid-test, and is still a real, finite lifetime.
 */
const ID_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export interface IdTokenInput {
  store: Store;
  /** `iss`: the public base URL, equal to the discovery document's `issuer`. */
  issuer: string;
  /** `aud`: the client the code was issued to. */
  clientId: string;
  user: StoredUser;
  /** Hashed into `at_hash`. */
  accessToken: string;
  /** Wall-clock sign-in time. */
  authTimeMs: number;
  /** "pwd" for a member client, else null: ORCID returns `amr` to the Member API only. */
  amr: string | null;
  /** From the authorize request; null when it had none. */
  nonce: string | null;
}

/**
 * `at_hash`: the base64url of the left half of the access token's SHA-256, as OpenID Connect Core
 * section 3.1.3.6 defines it for RS256 (https://openid.net/specs/openid-connect-core-1_0.html).
 * ORCID's legacy implementation computes it for every ID token, the code flow included:
 * https://github.com/ORCID/ORCID-Source/blob/7eeb1e7709760f328f5d3f72ebf2629f0a5d54c9/orcid-core/src/main/java/org/orcid/core/oauth/openid/OpenIDConnectTokenEnhancer.java#L95
 */
async function accessTokenHash(accessToken: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken));
  return base64url.encode(new Uint8Array(digest, 0, 16));
}

/**
 * Signs the ID token with the tenant's key. The protected header is exactly `kid` then `alg`
 * (`RS256`), with no `typ`, as in every ORCID example:
 * https://github.com/ORCID/ORCID-Source/blob/7eeb1e7709760f328f5d3f72ebf2629f0a5d54c9/orcid-core/src/main/java/org/orcid/core/oauth/openid/OpenIDConnectKeyService.java#L82-L88
 *
 * The claims follow ORCID's legacy implementation (the last readable one) and its examples:
 * `aud` is the client id as a string, `sub` the bare iD, `amr` a string and only for a member
 * client, `nonce` only when the request had one, and the three name claims only for a public
 * name and only for the fields that exist. There is no `email`, `email_verified`, or `locale`:
 * https://github.com/ORCID/ORCID-Source/blob/7eeb1e7709760f328f5d3f72ebf2629f0a5d54c9/orcid-core/src/main/java/org/orcid/core/oauth/openid/OpenIDConnectTokenEnhancer.java#L90-L135
 * Keys are written in the order of ORCID's printed example, then `jti`, `at_hash`, and the names:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-web/ORCID_AUTH_WITH_OPENID_CONNECT.md#L89
 *
 * `iat` and `exp` are wall-clock seconds, never shifted by the admin clock, so a client library
 * that checks them against its own clock accepts the token.
 */
export async function signIdToken(input: IdTokenInput): Promise<string> {
  const key = await getSigningKey(input.store);
  const names = publicNameClaims(input.user);
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims = {
    aud: input.clientId,
    sub: input.user.orcid,
    auth_time: Math.floor(input.authTimeMs / 1000),
    ...(input.amr === null ? {} : { amr: input.amr }),
    iss: input.issuer,
    exp: issuedAt + ID_TOKEN_TTL_SECONDS,
    iat: issuedAt,
    ...(input.nonce === null ? {} : { nonce: input.nonce }),
    jti: crypto.randomUUID(),
    at_hash: await accessTokenHash(input.accessToken),
    ...(names.given_name === null ? {} : { given_name: names.given_name }),
    ...(names.family_name === null ? {} : { family_name: names.family_name }),
    ...(names.name === null ? {} : { name: names.name }),
  };
  return new SignJWT(claims)
    .setProtectedHeader({ kid: key.kid, alg: "RS256" })
    .sign(await importSigningKey(key));
}
