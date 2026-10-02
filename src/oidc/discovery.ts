// GET /.well-known/openid-configuration: ORCID's discovery document, byte for byte.
import type { Context } from "hono";
import type { AppEnv } from "../app";
import { type JsonObject, prettyJson } from "../json";
import { corsHeaders, OIDC_JSON } from "./headers";

/**
 * The fields and their order are ORCID's, as https://orcid.org/.well-known/openid-configuration
 * answered on 2026-10-01 (826 bytes, no trailing newline). ORCID serializes a Java object with
 * Jackson's default pretty printer (`prettyJson`, src/json.ts), with the base URI as the issuer
 * and as the prefix of every endpoint, and the field order is the order of that object's fields,
 * `issuer` last, which an object literal keeps:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/oauth/openid/OpenIDConnectDiscoveryService.java#L17-L50
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-web/src/main/java/org/orcid/frontend/web/controllers/OpenIDController.java#L143-L149
 *
 * The document advertises things this mock does not serve: the `id_token` and `id_token token`
 * response types and the `implicit` grant. Fidelity of the document wins over consistency with
 * the rest of the server: a client that reads it gets what ORCID's own gives it, and the
 * authorize endpoint answers `unsupported_response_type` for those response types.
 * Also faithful: no `revocation_endpoint`, no PKCE, no `client_credentials` grant, and
 * `scopes_supported` is only `openid`.
 */
function discoveryDocument(base: string): JsonObject {
  return {
    token_endpoint_auth_signing_alg_values_supported: ["RS256"],
    id_token_signing_alg_values_supported: ["RS256"],
    userinfo_endpoint: `${base}/oauth/userinfo`,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    jwks_uri: `${base}/oauth/jwks`,
    claims_supported: ["family_name", "given_name", "name", "auth_time", "iss", "sub"],
    scopes_supported: ["openid"],
    subject_types_supported: ["public"],
    response_types_supported: ["code", "id_token", "id_token token"],
    claims_parameter_supported: false,
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    grant_types_supported: ["authorization_code", "implicit", "refresh_token"],
    issuer: base,
  };
}

export function discoveryEndpoint(c: Context<AppEnv>): Response {
  const { publicBaseUrl } = c.get("deps").config;
  return c.body(prettyJson(discoveryDocument(publicBaseUrl)), 200, {
    ...OIDC_JSON,
    ...corsHeaders(c),
  });
}
