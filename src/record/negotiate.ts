// `Accept` negotiation for the record API, and the `Content-Type` it echoes.
//
// ORCID's public resources produce six types, each with a server weight `qs`:
// https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-pub-web/src/main/java/org/orcid/api/publicV3/server/PublicV3ApiServiceImplV3_0.java#L149
//   application/vnd.orcid+xml (0.5), application/orcid+xml (0.3), application/xml,
//   application/vnd.orcid+json (0.4), application/orcid+json (0.2), application/json
// https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/api/OrcidApiConstants.java#L75-L83
// A missing or wildcard `Accept` gets XML, and an `Accept` that names a JSON type gets JSON
// (observed on pub.orcid.org/v3.0 on 2026-10-01); `application/json` is compact and the two ORCID
// JSON types are Jackson-pretty-printed. orcid-mock serves JSON only, so a request that real
// ORCID would answer with XML is a deviation the caller sees as a 406 (see `Negotiation`).

export interface Negotiated {
  /** The `Content-Type` to send: the chosen media range as the client wrote it. */
  contentType: string;
  /** True for the two ORCID JSON types, which are pretty-printed. */
  pretty: boolean;
}

export type Negotiation =
  /** The client asked for a JSON type orcid-mock serves. */
  | { kind: "json"; negotiated: Negotiated }
  /** Real ORCID would answer XML; orcid-mock has no XML yet (a documented deviation). */
  | { kind: "xml" }
  /** No type the client accepts is one ORCID produces: the standard 406 / 9001. */
  | { kind: "unsupported" }
  /** The header is not a valid `Accept`: ORCID's web server answers 400 with an HTML page. */
  | { kind: "malformed" };

interface MediaRange {
  type: string;
  subtype: string;
  /** The parameters, names lowercased, a repeated name keeping its last value, without `q`. */
  params: Map<string, string>;
  q: number;
  /** Position in the header, to keep equally good ranges in the order the client wrote them. */
  index: number;
}

interface ServerType {
  mediaType: string;
  /** ORCID's `qs`; a type declared without one counts as 1. */
  qs: number;
  family: "json" | "xml";
  pretty: boolean;
}

const SERVER_TYPES: readonly ServerType[] = [
  { mediaType: "application/vnd.orcid+xml", qs: 0.5, family: "xml", pretty: false },
  { mediaType: "application/orcid+xml", qs: 0.3, family: "xml", pretty: false },
  { mediaType: "application/xml", qs: 1, family: "xml", pretty: false },
  { mediaType: "application/vnd.orcid+json", qs: 0.4, family: "json", pretty: true },
  { mediaType: "application/orcid+json", qs: 0.2, family: "json", pretty: true },
  { mediaType: "application/json", qs: 1, family: "json", pretty: false },
];

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const QVALUE = /^(?:[01](?:\.\d{0,3})?|\.\d{1,3})$/;

/** Splits on `separator` outside double-quoted strings. */
function splitOutsideQuotes(source: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of source) {
    if (char === '"') quoted = !quoted;
    if (char === separator && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

/** A parameter value: a token, or a quoted string whose quotes are dropped. */
function paramValue(raw: string): string | null {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  return raw === "" || TOKEN.test(raw) ? raw : null;
}

/**
 * The media ranges of an `Accept` header, or null when it is malformed. ORCID's web server answers
 * 400 for each of these (observed on pub.orcid.org/v3.0 on 2026-10-01): an empty element before
 * the last (`,application/json`, `a,,b`; a trailing comma is fine), a `type/` or `/subtype` or
 * `a/b/c`, a space inside a type, a parameter with no `=` or with spaces around it, an unquoted
 * value with a space, and a `q` that is not 0 to 1 with at most three decimals (`.5`, `1.`, and
 * `0.` are fine). A bare word is a type with any subtype (`garbage` is `garbage/*`), and an empty
 * parameter (`;;`) is ignored.
 */
function parseAccept(header: string): MediaRange[] | null {
  const elements = splitOutsideQuotes(header, ",");
  if (elements.length > 1 && (elements[elements.length - 1] ?? "").trim() === "") elements.pop();
  const ranges: MediaRange[] = [];
  for (const [index, element] of elements.entries()) {
    const [mediaType = "", ...rawParams] = splitOutsideQuotes(element, ";").map((part) =>
      part.trim(),
    );
    const halves = mediaType.split("/");
    if (halves.length > 2 || mediaType === "") return null;
    const [type = "", subtype = "*"] = halves;
    if (!TOKEN.test(type) || !TOKEN.test(subtype)) return null;
    const params = new Map<string, string>();
    let q = 1;
    for (const raw of rawParams) {
      if (raw === "") continue;
      const equals = raw.indexOf("=");
      if (equals < 1) return null;
      const name = raw.slice(0, equals);
      if (!TOKEN.test(name)) return null;
      const value = paramValue(raw.slice(equals + 1));
      if (value === null) return null;
      const lowered = name.toLowerCase();
      if (lowered === "q") {
        if (!QVALUE.test(value) || Number(value) > 1) return null;
        q = Number(value);
      } else if (lowered !== "qs") {
        // A `qs` from the client does not weigh anything and is not echoed (observed).
        params.set(lowered, value);
      }
    }
    ranges.push({ type, subtype, params, q, index });
  }
  return ranges;
}

/** One way a range can be answered: by a server type, or (null) by whichever XML ORCID picks. */
interface Option {
  range: MediaRange;
  server: ServerType | null;
}

/** `*` is least specific, then `type/*`, then a full type. */
function specificity(range: MediaRange): number {
  if (range.type === "*" && range.subtype === "*") return 0;
  return range.subtype === "*" || range.type === "*" ? 1 : 2;
}

/**
 * The server types a range names. A full type names itself; `application/*` and the full
 * wildcard match every type and, as observed, answer an XML one (`xml`); a wildcard type with a
 * subtype (star, slash, `json`) names the type with that subtype (observed: it got
 * `application/json`); any other `type/*` and any unknown type name nothing.
 */
function candidates(range: MediaRange): ServerType[] | "any-xml" {
  const type = range.type.toLowerCase();
  const subtype = range.subtype.toLowerCase();
  if (subtype === "*" && (type === "*" || type === "application")) return "any-xml";
  return SERVER_TYPES.filter(
    (server) =>
      server.mediaType === `${type}/${subtype}` ||
      (type === "*" && server.mediaType.endsWith(`/${subtype}`)),
  );
}

/** `x=a` for a token value, `x="a b"` otherwise; an empty value is written bare, as ORCID does. */
function paramText(name: string, value: string): string {
  return value === "" || TOKEN.test(value) ? `${name}=${value}` : `${name}="${value}"`;
}

/**
 * Picks the representation for an `Accept` header, as ORCID does (every rule observed on
 * pub.orcid.org/v3.0 on 2026-10-01): ranges are tried by the client's quality (a `q=0` range is
 * still acceptable, last), then specificity, then the server's own weight `qs`, then the order
 * written; the first range that names a type ORCID produces wins, so `application/json,
 * application/vnd.orcid+xml` is JSON in either order (`qs` 1 against 0.5) and `application/xml,
 * application/json` is XML only because it is listed first.
 * A missing or blank header accepts anything, so it answers `xml`.
 * The `Content-Type` echo is the chosen range as the client wrote it: type and subtype in the
 * client's case, parameters lowercased with a repeat keeping its last value and `q` and `qs`
 * dropped, then `charset=UTF-8` only when the client gave no charset (orcid-mock choice: the
 * parameters keep the order written, where ORCID's follow a hash map's).
 */
export function negotiate(accept: string | null | undefined): Negotiation {
  if (accept === null || accept === undefined || accept.trim() === "") return { kind: "xml" };
  const ranges = parseAccept(accept);
  if (ranges === null) return { kind: "malformed" };

  const ordered = ranges
    .flatMap((range): Option[] => {
      const named = candidates(range);
      if (named === "any-xml") return [{ range, server: null }];
      return named.map((server) => ({ range, server }));
    })
    .sort(
      (a, b) =>
        b.range.q - a.range.q ||
        specificity(b.range) - specificity(a.range) ||
        (b.server?.qs ?? 0) - (a.server?.qs ?? 0) ||
        a.range.index - b.range.index,
    );

  const best = ordered[0];
  if (best === undefined) return { kind: "unsupported" };
  const { range, server } = best;
  if (server === null || server.family === "xml") return { kind: "xml" };
  const params = [...range.params].map(([name, value]) => paramText(name, value));
  if (!range.params.has("charset")) params.push("charset=UTF-8");
  // A wildcard type has no spelling of its own to echo, so the type it matched is written.
  const written = range.type === "*" ? server.mediaType : `${range.type}/${range.subtype}`;
  return {
    kind: "json",
    negotiated: { contentType: [written, ...params].join(";"), pretty: server.pretty },
  };
}
