// The path and query of a request, read from the text of its URL and never through `new URL`.
// Every absolute URL derives from PUBLIC_BASE_URL and none from the `Host` header (ADR 0001), and a
// `Host` that does not parse (`[::1`, `a:b:c`, `%zz`, a port above 65535) makes `new URL(c.req.url)`
// throw, which a client controls: it would turn a request for a valid path into a 500.

export interface RequestTarget {
  /** The path as sent, still percent-encoded, and `/` when the URL has none. */
  path: string;
  /** The query string without its `?`, or the empty string. */
  search: string;
}

/**
 * Splits a request URL's text into its path and query, ignoring the authority and any fragment.
 * Bun builds `Request.url` from the `Host` header, and leaves it relative (just the request
 * target) when that header cannot be made into a URL; a runtime that always sends an absolute
 * URL, such as Workers, is handled the same way: the target starts at the first `/` or `?` after
 * `://`, since a valid authority holds neither.
 */
export function requestTarget(url: string): RequestTarget {
  const hash = url.indexOf("#");
  const text = hash === -1 ? url : url.slice(0, hash);
  let target = text;
  if (!text.startsWith("/")) {
    const scheme = text.indexOf("://");
    const authorityStart = scheme === -1 ? 0 : scheme + 3;
    const targetStart = text.slice(authorityStart).search(/[/?]/);
    target = targetStart === -1 ? "" : text.slice(authorityStart + targetStart);
  }
  const queryStart = target.indexOf("?");
  const path = queryStart === -1 ? target : target.slice(0, queryStart);
  return {
    path: path === "" ? "/" : path,
    search: queryStart === -1 ? "" : target.slice(queryStart + 1),
  };
}
