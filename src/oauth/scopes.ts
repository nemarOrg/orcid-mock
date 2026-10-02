// Scope strings: parsing a request's `scope` parameter and formatting a granted set.
import type { ScopeName } from "../store/types";

/**
 * The scopes the mock knows. `/read-public` is a client-credentials scope only: the authorize
 * endpoint refuses it (ORCID's api_errors.md lists a 302 `Invalid scope` for a scope the client
 * may not request, ORCID-Source orcid-api-web/tutorial/api_errors.md).
 */
export const KNOWN_SCOPES: readonly ScopeName[] = [
  "/authenticate",
  "openid",
  "/read-limited",
  "/read-public",
];

export interface ParsedScopes {
  /** The known scopes, deduplicated, in the order the request listed them. */
  scopes: ScopeName[];
  /** Every token that is not a known scope, in request order. */
  unknown: string[];
}

function isKnownScope(token: string): token is ScopeName {
  return (KNOWN_SCOPES as readonly string[]).includes(token);
}

/**
 * Splits a scope parameter on whitespace. The caller passes the already URL-decoded value, in
 * which both `+` and `%20` have become spaces; ORCID's own examples write
 * `scope=openid%20/activities/update%20/read-limited` (ORCID-Source
 * orcid-api-web/tutorial/token_delegation.md), and `application/x-www-form-urlencoded` clients
 * write `+`. A missing or blank parameter parses to no scopes.
 */
export function parseScopes(raw: string | null | undefined): ParsedScopes {
  const scopes: ScopeName[] = [];
  const unknown: string[] = [];
  for (const token of (raw ?? "").split(/\s+/)) {
    if (token === "") continue;
    if (!isKnownScope(token)) unknown.push(token);
    else if (!scopes.includes(token)) scopes.push(token);
  }
  return { scopes, unknown };
}

/**
 * The `scope` string of a token response: space-separated, ORCID scopes keep their leading slash
 * and `openid` has none, as in ORCID's examples (`"/read-limited openid /activities/update"`,
 * ORCID-Source orcid-api-web/tutorial/token_delegation.md).
 * ORCID's own order is not the request order and is not documented, so orcid-mock choice: keep
 * the order the scopes were requested in.
 */
export function formatScopes(scopes: Iterable<ScopeName>): string {
  return [...scopes].join(" ");
}
