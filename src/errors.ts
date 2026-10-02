// The three error shapes this server speaks, one per family of routes, and the canonical ORCID
// record-API messages. No response body ever carries a stack trace or an exception message from
// an unexpected error: those are logged with their stack and answered generically.
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Issue } from "./fixtures/schema";
import { escapeHtml } from "./html";
import { type Json, prettyJson } from "./record/json";

export type ErrorStatus = ContentfulStatusCode;

/**
 * OAuth 2.0 error body, RFC 6749 section 5.2: `{ error, error_description }`.
 * ORCID's token endpoint (`invalid_client`) and its authorize errors (`invalid_request`) write
 * `error_description` first, observed on orcid.org on 2026-10-01; pass `descriptionFirst` there.
 * JSON key order carries no meaning for a client, but a byte-for-byte comparison would see it.
 */
export function oauthError(
  c: Context,
  status: ErrorStatus,
  error: string,
  description: string,
  opts: { descriptionFirst?: boolean; contentType?: string } = {},
): Response {
  const body = opts.descriptionFirst
    ? { error_description: description, error }
    : { error, error_description: description };
  return opts.contentType === undefined
    ? c.json(body, status)
    : c.json(body, status, { "Content-Type": opts.contentType });
}

/**
 * The JSON content types ORCID was observed to send: the token endpoint, the revoke endpoint, and
 * the record API's bad-bearer 401 use UTF-8 (observed on sandbox.orcid.org and
 * pub.sandbox.orcid.org on 2026-10-01), and the authorization server's `/oauth2/authorize` errors
 * use ISO-8859-1 (observed on auth.sandbox.orcid.org on 2026-10-01).
 */
export const JSON_UTF8 = "application/json;charset=UTF-8";
export const JSON_LATIN1 = "application/json;charset=ISO-8859-1";

/** An error from the token or revoke endpoint, in the content type ORCID sends there. */
export function tokenEndpointError(
  c: Context,
  status: ErrorStatus,
  error: string,
  description: string,
  opts: { descriptionFirst?: boolean } = {},
): Response {
  return oauthError(c, status, error, description, { ...opts, contentType: JSON_UTF8 });
}

/**
 * ORCID's answer to a token or revoke request that is not form-encoded or not a POST: 415 with
 * `text/html;charset=utf-8`, an `Accept: application/x-www-form-urlencoded` header, and a message
 * of the form `Content-Type 'application/json' is not supported.` (`'null'` when there is no
 * Content-Type, as for a GET), observed on sandbox.orcid.org on 2026-10-01.
 * ORCID's body is a Tomcat error page around that sentence; orcid-mock sends the sentence alone.
 */
export function unsupportedMediaType(c: Context, contentType: string | undefined): Response {
  return c.body(`Content-Type '${escapeHtml(contentType ?? "null")}' is not supported.`, 415, {
    "Content-Type": "text/html;charset=utf-8",
    Accept: "application/x-www-form-urlencoded",
    "Content-Language": "en",
  });
}

/** The admin API's error body: `{ error }`, plus `issues` for an invalid fixture. */
export function adminError(
  c: Context,
  status: ErrorStatus,
  error: string,
  issues?: ReadonlyArray<Issue>,
): Response {
  return c.json(issues === undefined ? { error } : { error, issues }, status);
}

export interface OrcidApiErrorSpec {
  status: ErrorStatus;
  code: number;
  developerMessage: string;
  userMessage: string;
}

// ORCID's troubleshooting link, the same in every error body: the `apiError.<code>.moreInfo` keys
// in api_en.properties:
// https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/resources/i18n/api_en.properties#L11
const MORE_INFO = "https://members.orcid.org/api/resources/troubleshooting";

/**
 * The five-key error object, which a bulk response also nests as `{ "error": ... }` for each
 * element that failed (observed on `/works/{put-codes}`).
 */
export function orcidErrorBody(spec: OrcidApiErrorSpec): Json {
  return {
    "response-code": spec.status,
    "developer-message": spec.developerMessage,
    "user-message": spec.userMessage,
    "error-code": spec.code,
    "more-info": MORE_INFO,
  };
}

/**
 * ORCID's v3.0 error body, keys in this fixed order, as observed on pub.orcid.org/v3.0 on
 * 2026-10-01: `response-code`, `developer-message`, `user-message`, `error-code`, `more-info`.
 * ORCID builds it in `getOrcidErrorV3`, from the `apiError.<code>.*` keys in api_en.properties:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/exception/OrcidCoreExceptionMapper.java#L221-L238
 * `contentType` is the negotiated type; real ORCID sends no Content-Type at all on a 9001
 * (observed on pub.orcid.org/v3.0 on 2026-10-01), so leaving it out sends none.
 * `pretty` writes the Jackson-pretty form, which errors take when the client asked for an ORCID
 * JSON type (observed: a 404 for `Accept: application/vnd.orcid+json` was pretty-printed).
 */
export function orcidApiError(
  c: Context,
  spec: OrcidApiErrorSpec,
  opts: { contentType?: string; headers?: Record<string, string>; pretty?: boolean } = {},
): Response {
  const body = orcidErrorBody(spec);
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.contentType !== undefined) headers["Content-Type"] = opts.contentType;
  return c.body(
    headerlessBody(
      opts.pretty ? prettyJson(body) : JSON.stringify(body),
      opts.contentType !== undefined,
    ),
    spec.status,
    headers,
  );
}

/**
 * Bun adds `application/octet-stream` to a byte-array body and `text/plain` to a string body, but
 * adds nothing to a stream, so a stream is the way to send JSON with no Content-Type header.
 */
function headerlessBody(
  json: string,
  hasContentType: boolean,
): string | ReadableStream<Uint8Array> {
  if (hasContentType) return json;
  const bytes = new TextEncoder().encode(json);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * The 9001 body ORCID sends for anything it cannot route or negotiate; `detail` varies
 * (`HTTP 404 Not Found`, `HTTP 406 Not Acceptable`, `HTTP 405 Method Not Allowed`).
 * Text: `apiError.9001.developerMessage` and `.userMessage` in api_en.properties, then
 * ` Full validation error: <detail>` appended by `getDeveloperMessage`:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/resources/i18n/api_en.properties#L9-L10
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/exception/OrcidCoreExceptionMapper.java#L249-L296
 */
export function unroutedError(status: ErrorStatus, detail: string): OrcidApiErrorSpec {
  return {
    status,
    code: 9001,
    developerMessage:
      "400 Bad Request: There is an issue with your data or the API endpoint. " +
      "405 Method Not Allowed: Endpoint and method mismatch. " +
      "415 Unsupported Media Type: data must be in XML or JSON format. " +
      `Full validation error: ${detail}`,
    userMessage: "ORCID could not process the data, because they were invalid.",
  };
}

// The literal placeholder ORCID leaves in a message when it has no value for it (observed).
const CLIENT_NAME_PLACEHOLDER = ["$", "{clientName}"].join("");

/**
 * The canonical record-API errors phase 4 serves. Each message is the `apiError.<code>` entry in
 * api_en.properties, with the ` Full validation error: ...` suffix `getDeveloperMessage` appends
 * where there is one (not for the 404 codes 9011, 9016, 9027, 9028, 9029, and 9041):
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/exception/OrcidCoreExceptionMapper.java#L249-L296
 * All were observed on pub.orcid.org/v3.0 on 2026-10-01 unless marked "source only".
 */
export const ORCID_API_ERRORS = {
  /** 9001 (`apiError.9001`), an unrouted path: `Full validation error: HTTP 404 Not Found`. */
  unrouted: unroutedError(404, "HTTP 404 Not Found"),
  /**
   * 9016 (`apiError.9016`), an unknown or malformed iD, or an unknown put-code:
   * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/resources/i18n/api_en.properties#L53-L54
   */
  notFound: {
    status: 404,
    code: 9016,
    developerMessage: "404 Not Found: The resource was not found.",
    userMessage: "The resource was not found.",
  },
  /**
   * 9039 (`apiError.9039`), a biography that is not public (observed); a single item that is not
   * public is source only, thrown by `checkIsPublic`:
   * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/resources/i18n/api_en.properties#L122-L123
   * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-api-common/src/main/java/org/orcid/api/publicV3/server/security/impl/PublicAPISecurityManagerV3Impl.java#L48-L52
   */
  notPublic: {
    status: 403,
    code: 9039,
    developerMessage:
      "403 Forbidden: The item is not public and cannot be accessed with the Public API.",
    userMessage: "The client application is forbidden to perform the action.",
  },
  /**
   * 9042 (`apiError.9042.userMessage`), more than 100 put-codes on a bulk read: HTTP 400, not
   * 413. The key has no developerMessage, so the body carries the exception class name and the
   * validation error, as `getDeveloperMessage` does:
   * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/resources/i18n/api_en.properties#L131-L132
   * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/manager/v3/read_only/impl/WorkManagerReadOnlyImpl.java#L441-L447
   */
  tooManyPutCodes: {
    status: 400,
    code: 9042,
    developerMessage:
      "org.orcid.core.exception.ExceedMaxNumberOfPutCodesException Full validation error: Too many put codes specified: maximum is 100",
    userMessage: "Too many put codes supplied",
  },
  /**
   * 9044 (`apiError.9044`), a deactivated record:
   * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/resources/i18n/api_en.properties#L136-L137
   * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/manager/v3/impl/OrcidSecurityManagerImpl.java#L192-L197
   */
  deactivated: (orcid: string): OrcidApiErrorSpec => ({
    status: 409,
    code: 9044,
    developerMessage: `409 Conflict: The ORCID record is deactivated and cannot be edited. Full validation error: ${orcid} is deactivated`,
    userMessage: "The ORCID record is deactivated.",
  }),
  /**
   * 9018 (`apiError.9018`), a locked record. Source only (no locked record was found to observe),
   * raised by `checkProfile`:
   * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/resources/i18n/api_en.properties#L59-L60
   * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/manager/v3/impl/OrcidSecurityManagerImpl.java#L185-L190
   */
  locked: (orcid: string): OrcidApiErrorSpec => ({
    status: 409,
    code: 9018,
    developerMessage: `409 Conflict: The ORCID record is locked and cannot be edited. ORCID ${orcid} Full validation error: ${orcid} is locked`,
    userMessage: "The ORCID record is locked.",
  }),
  /**
   * 9036 (`apiError.9036`), an unclaimed record inside the claim wait period. Source only, from
   * the same `checkProfile`:
   * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/resources/i18n/api_en.properties#L113-L114
   * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/manager/v3/impl/OrcidSecurityManagerImpl.java#L169-L183
   */
  unclaimed: {
    status: 409,
    code: 9036,
    developerMessage: "409 Conflict: This record has not been claimed.",
    userMessage:
      "This record has not been claimed, if this is your record you can claim it at https://orcid.org/resend-claim.",
  },
  /**
   * 9007 (`apiError.9007`), a deprecated record; the response is a 301 whose `Location` points at
   * the primary record with the same path suffix. The URIs are ORCID's `https://orcid.org/<iD>`
   * form (orcid-mock builds them from `PUBLIC_BASE_URL`):
   * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/resources/i18n/api_en.properties#L27-L28
   * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/manager/v3/impl/OrcidSecurityManagerImpl.java#L155-L167
   */
  deprecated: (primaryUri: string, ownUri: string): OrcidApiErrorSpec => ({
    status: 301,
    code: 9007,
    developerMessage: `301 Moved Permanently: This account is deprecated. Please refer to account: ${primaryUri}. ORCID ${ownUri}`,
    userMessage: `This account is deprecated. Please refer to account: ${primaryUri}.`,
  }),
  /**
   * 9001 with `HTTP 406 Not Acceptable`: an `Accept` header that names no type ORCID produces
   * (`text/csv`, `text/html`, `text/*`, `application/ld+json`), observed with no Content-Type.
   */
  notAcceptable: unroutedError(406, "HTTP 406 Not Acceptable"),
  /** 9001 with `HTTP 405 Method Not Allowed`: any method but GET, HEAD, and OPTIONS (observed). */
  methodNotAllowed: unroutedError(405, "HTTP 405 Method Not Allowed"),
  /**
   * 9001 with the `NumberFormatException` a non-numeric put-code on a single-item path raises
   * (observed for `/work/abc`): JAX-RS answers 404 when a path parameter does not convert, and
   * the exception is the cause.
   */
  unroutedPutCode: (raw: string): OrcidApiErrorSpec =>
    unroutedError(
      404,
      `HTTP 404 Not Found (java.lang.NumberFormatException: For input string: "${raw}")`,
    ),
  /**
   * 9041 (`apiError.9041`), a record with no biography at all. Source only: `checkIsPublic`
   * throws it for a null biography, and a 404 code gets no `Full validation error` suffix:
   * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/resources/i18n/api_en.properties#L128-L129
   * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-api-common/src/main/java/org/orcid/api/publicV3/server/security/impl/PublicAPISecurityManagerV3Impl.java#L55-L58
   */
  noBiography: {
    status: 404,
    code: 9041,
    developerMessage: "404 Not Found: Biography for the given record is null.",
    userMessage: "There is no biography for the given record.",
  },
  /**
   * 9006 (`apiError.9006`), an element of a bulk put-code list that is not a number. The
   * `NumberFormatException` is an `IllegalArgumentException`, which maps to 400 / 9006, and its
   * message is `For input string: "<element>"` (observed for `abc`, `1.5`, and an empty element):
   * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/resources/i18n/api_en.properties#L24-L25
   * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/manager/v3/read_only/impl/WorkManagerReadOnlyImpl.java#L384-L387
   */
  badPutCode: (raw: string): OrcidApiErrorSpec => ({
    status: 400,
    code: 9006,
    developerMessage: `The client application sent a bad request to ORCID. Full validation error: For input string: "${raw}"`,
    userMessage: "The client application sent a bad request to ORCID.",
  }),
  /**
   * 9034 (`apiError.9034`), one bulk element whose put-code is not one of the record's (observed:
   * an unknown put-code, another record's, a repeated one, and `007`, which reads as 7). ORCID
   * fills `${clientName}` with the calling client's name; an anonymous reader has none, so the
   * placeholder stays in the text (observed):
   * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/resources/i18n/api_en.properties#L107-L108
   * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/manager/v3/read_only/impl/WorkManagerReadOnlyImpl.java#L400-L403
   * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/exception/OrcidCoreExceptionMapper.java#L225-L229
   */
  invalidPutCode: (putCode: string, clientName: string | null): OrcidApiErrorSpec => ({
    status: 400,
    code: 9034,
    developerMessage: `400 Bad Request: The put code provided is not valid. Full validation error: '${putCode}' is not a valid put code`,
    userMessage: `There was an error when updating the record. Please try again. If the error persists, please contact ${clientName ?? CLIENT_NAME_PLACEHOLDER} for assistance.`,
  }),
} satisfies Record<string, OrcidApiErrorSpec | ((...args: never[]) => OrcidApiErrorSpec)>;

/**
 * orcid-mock's own 406 / 9001 for a request real ORCID would answer with XML: an `Accept` header
 * that is missing, a wildcard, or names an XML type. orcid-mock serves JSON only until XML
 * exists, and a 406 surfaces a client that depends on a default instead of hiding it behind a
 * response it cannot parse. The status and the 9001 shape are the standard 406; the developer
 * message is orcid-mock's.
 */
export function jsonOnlyError(accept: string | null | undefined): OrcidApiErrorSpec {
  const sent =
    accept === null || accept === undefined || accept.trim() === ""
      ? "no Accept header"
      : `Accept: ${accept}`;
  return {
    status: 406,
    code: 9001,
    developerMessage:
      `406 Not Acceptable: orcid-mock serves JSON only, and real ORCID would answer this request (${sent}) with XML. ` +
      "Send Accept: application/json, application/orcid+json, or application/vnd.orcid+json.",
    userMessage: "ORCID could not process the data, because they were invalid.",
  };
}
