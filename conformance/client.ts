// The client code under test, written the way an integrator writes one: plain `fetch`, the two
// base URLs and a client's credentials from configuration, and nothing that knows whether the
// other end is orcid-mock or ORCID's sandbox. The suite runs this file unchanged against both.
import type { Target } from "./target";

/** What a call answered. `json` is undefined when the body is empty or not JSON. */
export interface Reply {
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
}

const USER_AGENT = "orcid-mock-conformance (+https://github.com/nemarOrg/orcid-mock)";

/** A request that takes longer is a failure; it stays below the 30 seconds Bun gives a test. */
const REQUEST_TIMEOUT_MS = 20_000;

/** What a service sends for a moment's trouble: too many requests, or a gateway that blinked. */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);
const DEFAULT_RETRY_WAIT_MS = 1_000;
const MAX_RETRY_WAIT_MS = 30_000;

/**
 * How long to wait before trying a reply's request again, or null when the reply is not a
 * transient failure. `retryAfter` is the `Retry-After` header, either whole seconds or an HTTP
 * date; the wait is capped at 30 seconds, and a header that is absent or unreadable means one.
 */
export function retryDelayMs(
  status: number,
  retryAfter: string | null,
  now: number = Date.now(),
): number | null {
  if (!TRANSIENT_STATUSES.has(status)) return null;
  const header = (retryAfter ?? "").trim();
  let wait = DEFAULT_RETRY_WAIT_MS;
  if (/^\d+$/.test(header)) {
    wait = Number(header) * 1000;
  } else if (/[a-z]/i.test(header)) {
    // An HTTP date names a day and a month; a bare number that is not whole seconds is unreadable.
    const date = Date.parse(header);
    if (!Number.isNaN(date)) wait = Math.max(0, date - now);
  }
  return Math.min(wait, MAX_RETRY_WAIT_MS);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createClient(target: Target) {
  let lastRequestAt = 0;

  /** One request at a time, at least `requestDelayMs` apart, and a redirect is never followed. */
  async function attempt(url: string, options: RequestOptions): Promise<Reply> {
    const wait = lastRequestAt + target.requestDelayMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    const response = await fetch(url, {
      method: options.method ?? "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // Say who is asking, so a service that sees a weekly run can tell what it is.
      headers: { "user-agent": USER_AGENT, ...options.headers },
      ...(options.body === undefined ? {} : { body: options.body }),
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      // Not JSON: the 415 page, an empty body.
    }
    return { status: response.status, headers: response.headers, text, json };
  }

  /**
   * `attempt`, and once more after a transient failure (429, 502, 503, or 504, honoring
   * `Retry-After`), so one blink of a shared service does not fail a run. Says so when it does.
   */
  async function request(url: string, options: RequestOptions = {}): Promise<Reply> {
    const first = await attempt(url, options);
    const wait = retryDelayMs(first.status, first.headers.get("retry-after"));
    if (wait === null) return first;
    console.warn(
      `${options.method ?? "GET"} ${new URL(url).pathname} answered ${first.status}; retrying once in ${wait} ms`,
    );
    await sleep(wait);
    return attempt(url, options);
  }

  const tokenUrl = `${target.apiBase}/oauth/token`;

  /** `{pubApiBase}/v3.0/{iD}/{path}`; `path` may be empty or a section. */
  const recordUrl = (iD: string, path: string) =>
    `${target.pubApiBase}/v3.0/${iD}${path === "" ? "" : `/${path}`}`;

  /** A form-encoded POST to the token endpoint, as ORCID requires. */
  function tokenRequest(fields: Record<string, string>): Promise<Reply> {
    return request(tokenUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields),
    });
  }

  let grant: Promise<Reply> | undefined;

  /** The client-credentials grant for `/read-public`; made once, since a token lasts years. */
  function clientCredentials(): Promise<Reply> {
    grant ??= tokenRequest({
      grant_type: "client_credentials",
      scope: "/read-public",
      client_id: target.clientId,
      client_secret: target.clientSecret,
    });
    return grant;
  }

  /**
   * The access token from `clientCredentials()`. When there is none, the error says why in
   * the server's own words (`error` and `error_description`) and never prints a body.
   */
  async function clientCredentialsToken(): Promise<string> {
    const reply = await clientCredentials();
    const body = (reply.json ?? {}) as Record<string, unknown>;
    const token = body.access_token;
    if (reply.status !== 200 || typeof token !== "string") {
      const detail = ["error", "error_description"]
        .filter((key) => typeof body[key] === "string")
        .map((key) => `${key}: ${String(body[key])}`);
      throw new Error(
        `The client-credentials grant answered ${reply.status}, not a token${
          detail.length > 0 ? ` (${detail.join("; ")})` : ""
        }.`,
      );
    }
    return token;
  }

  /**
   * One record section for an iD, as JSON. `Accept` is always sent: Bun's and Node's `fetch`
   * default to a wildcard, which ORCID answers with XML.
   */
  function readRecord(
    iD: string,
    section: string,
    token?: string,
    accept = "application/json",
  ): Promise<Reply> {
    return request(recordUrl(iD, section), {
      headers: {
        accept,
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
    });
  }

  /** Full works for up to 100 put-codes in one call. */
  function readWorks(iD: string, putCodes: readonly number[], token?: string): Promise<Reply> {
    return readRecord(iD, `works/${putCodes.join(",")}`, token);
  }

  return {
    request,
    tokenUrl,
    tokenRequest,
    clientCredentials,
    clientCredentialsToken,
    readRecord,
    readWorks,
  };
}

export type Client = ReturnType<typeof createClient>;
