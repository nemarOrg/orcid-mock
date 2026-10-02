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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createClient(target: Target) {
  let lastRequestAt = 0;

  /** One request at a time, at least `requestDelayMs` apart, and a redirect is never followed. */
  async function request(url: string, options: RequestOptions = {}): Promise<Reply> {
    const wait = lastRequestAt + target.requestDelayMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    const response = await fetch(url, {
      method: options.method ?? "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
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

  /** The access token from `clientCredentials()`; throws, without the body, unless it was a 200. */
  async function clientCredentialsToken(): Promise<string> {
    const reply = await clientCredentials();
    const token = (reply.json as { access_token?: unknown } | undefined)?.access_token;
    if (reply.status !== 200 || typeof token !== "string") {
      throw new Error(`The client-credentials grant answered ${reply.status}, not a token.`);
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
    recordUrl,
    tokenRequest,
    clientCredentials,
    clientCredentialsToken,
    readRecord,
    readWorks,
  };
}

export type Client = ReturnType<typeof createClient>;
