// Redirect URI matching and the redirects built from one.
// Matching works on the raw string, not on `new URL`: the URL parser lowercases the host and
// resolves dot segments, and ORCID's rule is case-sensitive on the host.

// scheme, userinfo, host, port, path, query, fragment: the pieces of RFC 3986 section 3.
const URI_PATTERN =
  /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(?:([^@/?#]*)@)?(\[[^\]]*\]|[^:/?#@]*)(?::([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/;

interface ParsedUri {
  scheme: string;
  userinfo: string | undefined;
  host: string;
  port: string | undefined;
  path: string;
}

function parseUri(raw: string): ParsedUri | null {
  const match = URI_PATTERN.exec(raw);
  if (!match) return null;
  const [, scheme, userinfo, host, port, path] = match;
  if (scheme === undefined || host === undefined || host === "") return null;
  return { scheme: scheme.toLowerCase(), userinfo, host, port, path: path ?? "" };
}

/**
 * Resolves `.` and `..` segments and turns `\\` into `/`, as Spring's `StringUtils.cleanPath`
 * does for ORCID, and also treats `%2e` as a dot, which ORCID's code does not: a browser
 * resolves `/callback/%2e%2e/other` to `/other` (WHATWG URL, path state, "double-dot path
 * segment"), so leaving it alone would let a requested path pass the prefix check and then land
 * outside it. orcid-mock choice, stricter than ORCID. `..` never climbs above the root.
 */
function cleanPath(path: string): string {
  const out: string[] = [];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    const dots = segment.toLowerCase().replaceAll("%2e", ".");
    if (dots === ".") continue;
    if (dots === "..") {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(segment);
  }
  const cleaned = out.join("/");
  return path.startsWith("/") && !cleaned.startsWith("/") ? `/${cleaned}` : cleaned;
}

/** Visible ASCII only: anything else cannot be a `Location` header value as it stands. */
const SAFE_URI = /^[\x21-\x7e]+$/;

/**
 * Whether `requested` is allowed by one of the client's registered redirect URIs.
 * ORCID's rule (ORCID-Source orcid-core/src/main/java/org/orcid/core/oauth/security/
 * OrcidOauthRedirectResolver.java, and https://info.orcid.org/ufaqs/how-do-redirect-uris-work/):
 * scheme, userinfo, host (exact, case-sensitive), and port are equal, and the cleaned requested
 * path starts with the cleaned registered path, so a host-only registration allows any path and
 * `/callback` allows `/callback/sub` (and, because ORCID's test is a plain `startsWith`,
 * `/callbackx`). The query and fragment of the requested URI take no part in matching.
 * A port is compared as written, so `https://host` does not match `https://host:443` (the
 * Spring `UriComponents` the resolver builds on reports an absent port as -1).
 * orcid-mock choice: a requested URI with a space, a control character, or a non-ASCII character
 * never matches, because it could not be sent back in a header; clients percent-encode those.
 */
export function redirectUriMatches(requested: string, registered: readonly string[]): boolean {
  if (!SAFE_URI.test(requested)) return false;
  const wanted = parseUri(requested);
  if (!wanted) return false;
  const wantedPath = cleanPath(wanted.path);
  return registered.some((candidate) => {
    const allowed = parseUri(candidate);
    return (
      allowed !== null &&
      allowed.scheme === wanted.scheme &&
      allowed.userinfo === wanted.userinfo &&
      allowed.host === wanted.host &&
      allowed.port === wanted.port &&
      wantedPath.startsWith(cleanPath(allowed.path))
    );
  });
}

/**
 * Appends query parameters to a redirect URI: `?` if it has no query yet, `&` if it has one, and
 * before any fragment so the fragment survives. Values are percent-encoded once.
 */
export function withQuery(uri: string, params: ReadonlyArray<readonly [string, string]>): string {
  const hash = uri.indexOf("#");
  const base = hash === -1 ? uri : uri.slice(0, hash);
  const fragment = hash === -1 ? "" : uri.slice(hash);
  const query = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  const separator = base.endsWith("?") || base.endsWith("&") ? "" : base.includes("?") ? "&" : "?";
  return `${base}${separator}${query.join("&")}${fragment}`;
}

/** Replaces any fragment of a redirect URI with `fragment` (already encoded). */
export function withFragment(uri: string, fragment: string): string {
  const hash = uri.indexOf("#");
  return `${hash === -1 ? uri : uri.slice(0, hash)}#${fragment}`;
}
