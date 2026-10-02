// `Accept` negotiation for the record API, and the `Content-Type` it echoes.
//
// ORCID's public resources produce these six types, in this order of declaration:
// https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-pub-web/src/main/java/org/orcid/api/publicV3/server/PublicV3ApiServiceImplV3_0.java#L149
//   application/vnd.orcid+xml, application/orcid+xml, application/xml,
//   application/vnd.orcid+json, application/orcid+json, application/json
// (the two ORCID types are declared in OrcidApiConstants.java#L75-L83:
// https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/api/OrcidApiConstants.java#L75-L83)
// A missing or wildcard `Accept` gets XML, and an `Accept` that names only JSON gets JSON
// (observed on pub.orcid.org/v3.0 on 2026-10-01); `application/json` is compact and the two
// ORCID JSON types are Jackson-pretty-printed. orcid-mock serves JSON only, so a request that
// real ORCID would answer with XML is a deviation the caller sees as a 406 (see `Negotiation`).

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
  | { kind: "unsupported" };

interface MediaRange {
  type: string;
  subtype: string;
  /** The parameters before `q`, as written and without spaces around `=`. */
  params: string[];
  q: number;
  /** Position in the header, to keep equally good ranges in the order the client wrote them. */
  index: number;
}

const JSON_COMPACT = new Set(["application/json"]);
const JSON_PRETTY = new Set(["application/orcid+json", "application/vnd.orcid+json"]);
const XML = new Set(["application/xml", "application/orcid+xml", "application/vnd.orcid+xml"]);

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

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

/**
 * The media ranges of an `Accept` header. orcid-mock choice: a range that is not
 * `token/token` or has a `q` that is not 0 to 1 with at most three decimals is skipped, since
 * ORCID's handling of a malformed header was not observed.
 */
function parseAccept(header: string): MediaRange[] {
  const ranges: MediaRange[] = [];
  splitOutsideQuotes(header, ",").forEach((element, index) => {
    const [mediaType, ...rawParams] = splitOutsideQuotes(element, ";").map((part) => part.trim());
    const [type, subtype, ...extra] = (mediaType ?? "").split("/");
    if (type === undefined || subtype === undefined || extra.length > 0) return;
    if (!TOKEN.test(type) || !TOKEN.test(subtype)) return;
    const params: string[] = [];
    let q = 1;
    for (const raw of rawParams) {
      const equals = raw.indexOf("=");
      if (equals === -1) return;
      const name = raw.slice(0, equals).trim();
      const value = raw.slice(equals + 1).trim();
      if (name.toLowerCase() === "q") {
        if (!QVALUE.test(value)) return;
        q = Number(value);
        // RFC 9110: parameters after `q` are accept extensions, not part of the media type.
        break;
      }
      params.push(`${name}=${value}`);
    }
    ranges.push({ type, subtype, params, q, index });
  });
  return ranges;
}

/** `*` is least specific, then `type/*`, then a full type. */
function specificity(range: MediaRange): number {
  if (range.type === "*") return 0;
  return range.subtype === "*" ? 1 : 2;
}

/**
 * Picks the representation for an `Accept` header: ranges by quality, then specificity, then the
 * order written, and the first that names a type ORCID produces wins. The full wildcard and
 * `application/*` match the XML types first, as observed (they got `application/vnd.orcid+xml`
 * and `application/xml`), so they answer `xml`; `q=0` excludes a range, per RFC 9110.
 * A missing or blank header accepts anything, so it answers `xml` too.
 */
export function negotiate(accept: string | null | undefined): Negotiation {
  if (accept === null || accept === undefined || accept.trim() === "") return { kind: "xml" };
  const ranges = parseAccept(accept)
    .filter((range) => range.q > 0)
    .sort((a, b) => b.q - a.q || specificity(b) - specificity(a) || a.index - b.index);
  for (const range of ranges) {
    if (
      range.type === "*" ||
      (range.type.toLowerCase() === "application" && range.subtype === "*")
    ) {
      return { kind: "xml" };
    }
    const lowered = `${range.type}/${range.subtype}`.toLowerCase();
    if (XML.has(lowered)) return { kind: "xml" };
    const compact = JSON_COMPACT.has(lowered);
    if (compact || JSON_PRETTY.has(lowered)) {
      // The client's own spelling is echoed (observed: `APPLICATION/JSON` came back as
      // `APPLICATION/JSON;charset=UTF-8`), with `;charset=UTF-8` only when it gave no charset
      // (observed: `application/vnd.orcid+json;charset=utf-8` came back unchanged).
      const hasCharset = range.params.some((param) => /^charset=/i.test(param));
      const parts = [`${range.type}/${range.subtype}`, ...range.params];
      if (!hasCharset) parts.push("charset=UTF-8");
      return { kind: "json", negotiated: { contentType: parts.join(";"), pretty: !compact } };
    }
  }
  return { kind: "unsupported" };
}
