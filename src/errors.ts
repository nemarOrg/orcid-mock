// The three error shapes this server speaks, one per family of routes, and the canonical ORCID
// record-API messages. No response body ever carries a stack trace or an exception message from
// an unexpected error: those are logged with their stack and answered generically.
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Issue } from "./fixtures/schema";

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
  opts: { descriptionFirst?: boolean } = {},
): Response {
  return c.json(
    opts.descriptionFirst
      ? { error_description: description, error }
      : { error, error_description: description },
    status,
  );
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
// in ORCID/ORCID-Source orcid-core/src/main/resources/i18n/api_en.properties.
const MORE_INFO = "https://members.orcid.org/api/resources/troubleshooting";

/**
 * ORCID's v3.0 error body, keys in this fixed order, as observed on pub.orcid.org/v3.0 on
 * 2026-10-01: `response-code`, `developer-message`, `user-message`, `error-code`, `more-info`.
 * ORCID builds it in ORCID/ORCID-Source
 * orcid-core/src/main/java/org/orcid/core/exception/OrcidCoreExceptionMapper.java, from the
 * `apiError.<code>.*` keys in orcid-core/src/main/resources/i18n/api_en.properties.
 * `contentType` is the negotiated type; real ORCID sends no Content-Type at all on a 9001
 * (observed on pub.orcid.org/v3.0 on 2026-10-01), so leaving it out sends none.
 */
export function orcidApiError(
  c: Context,
  spec: OrcidApiErrorSpec,
  opts: { contentType?: string; headers?: Record<string, string> } = {},
): Response {
  const body = {
    "response-code": spec.status,
    "developer-message": spec.developerMessage,
    "user-message": spec.userMessage,
    "error-code": spec.code,
    "more-info": MORE_INFO,
  };
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.contentType !== undefined) headers["Content-Type"] = opts.contentType;
  return c.body(
    headerlessBody(JSON.stringify(body), opts.contentType !== undefined),
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
 * ` Full validation error: <detail>` appended by OrcidCoreExceptionMapper.
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

/**
 * The canonical record-API errors phase 4 serves. Each message is the `apiError.<code>` entry in
 * ORCID/ORCID-Source orcid-core/src/main/resources/i18n/api_en.properties, with the
 * ` Full validation error: ...` suffix OrcidCoreExceptionMapper appends where there is one.
 * All were observed on pub.orcid.org/v3.0 on 2026-10-01 unless marked "source only".
 */
export const ORCID_API_ERRORS = {
  /** 9001 (`apiError.9001`), an unrouted path: `Full validation error: HTTP 404 Not Found`. */
  unrouted: unroutedError(404, "HTTP 404 Not Found"),
  /** 9016 (`apiError.9016`), an unknown or malformed iD, or an unknown put-code. */
  notFound: {
    status: 404,
    code: 9016,
    developerMessage: "404 Not Found: The resource was not found.",
    userMessage: "The resource was not found.",
  },
  /**
   * 9039 (`apiError.9039`), a biography that is not public (observed); a single item that is not
   * public is source only (OrcidSecurityManagerImpl, orcid-core/src/main/java/org/orcid/core/
   * manager/v3/impl/OrcidSecurityManagerImpl.java).
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
   * validation error, as OrcidCoreExceptionMapper does.
   */
  tooManyPutCodes: {
    status: 400,
    code: 9042,
    developerMessage:
      "org.orcid.core.exception.ExceedMaxNumberOfPutCodesException Full validation error: Too many put codes specified: maximum is 100",
    userMessage: "Too many put codes supplied",
  },
  /** 9044 (`apiError.9044`), a deactivated record. */
  deactivated: (orcid: string): OrcidApiErrorSpec => ({
    status: 409,
    code: 9044,
    developerMessage: `409 Conflict: The ORCID record is deactivated and cannot be edited. Full validation error: ${orcid} is deactivated`,
    userMessage: "The ORCID record is deactivated.",
  }),
  /**
   * 9018 (`apiError.9018`), a locked record. Source only: raised by `checkProfile` in
   * ORCID-Source orcid-core/src/main/java/org/orcid/core/manager/v3/impl/OrcidSecurityManagerImpl.java.
   */
  locked: (orcid: string): OrcidApiErrorSpec => ({
    status: 409,
    code: 9018,
    developerMessage: `409 Conflict: The ORCID record is locked and cannot be edited. ORCID ${orcid} Full validation error: ${orcid} is locked`,
    userMessage: "The ORCID record is locked.",
  }),
  /**
   * 9036 (`apiError.9036`), an unclaimed record inside the claim wait period. Source only, from
   * the same `checkProfile`.
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
   * form.
   */
  deprecated: (primaryUri: string, ownUri: string): OrcidApiErrorSpec => ({
    status: 301,
    code: 9007,
    developerMessage: `301 Moved Permanently: This account is deprecated. Please refer to account: ${primaryUri}. ORCID ${ownUri}`,
    userMessage: `This account is deprecated. Please refer to account: ${primaryUri}.`,
  }),
} satisfies Record<string, OrcidApiErrorSpec | ((...args: never[]) => OrcidApiErrorSpec)>;
