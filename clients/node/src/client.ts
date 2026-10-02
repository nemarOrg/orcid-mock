// A typed client for orcid-mock's admin API and the headless sign-in sequence.
// It uses only the standard `fetch`, so it has no dependencies; the Testcontainers module and the
// Playwright fixture build on it.

/** The users-file visibility levels. */
export type Visibility = "public" | "limited" | "private";

/**
 * A user in the users-file form (`fixtures/users.schema.json`).
 *
 * Only the fields a helper needs are typed; every record section (`emails`, `works`, and the
 * rest) passes through as `unknown`, and the server validates the whole body. The server package
 * does not export its fixture types, so this is a minimal copy, and `tests/types.ts` fails the
 * type check if the server's `FixtureUser` stops being assignable to it.
 */
export interface OrcidMockUser {
  /** Empty or absent: the server mints a checksum-valid iD. */
  orcid?: string;
  claimed?: boolean;
  locked?: boolean;
  deactivated?: boolean;
  deprecated_to?: string;
  name: {
    given_names: string;
    family_name?: string | null | undefined;
    credit_name?: string | null | undefined;
    visibility: Visibility;
  };
  [section: string]: unknown;
}

/** A user as the admin API returns it: the iD is always filled in. */
export type OrcidMockUserRecord = OrcidMockUser & { orcid: string };

/** An OAuth client in the users-file form. */
export interface OrcidMockClientRegistration {
  /** Optional in the body of `putClient`, where the path already names it. */
  client_id?: string;
  client_secret: string;
  name?: string;
  redirect_uris: string[];
  /** A member client may ask for `/read-limited`. */
  member?: boolean;
}

/** The answer of `health()` and `reset()`. */
export interface OrcidMockHealth {
  status: "ok";
  users: number;
  clients: number;
}

/** The body of a successful token response; `name` is absent for client credentials. */
export interface OrcidMockTokenResponse {
  access_token: string;
  token_type: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  name?: string;
  orcid: string | null;
  id_token?: string;
}

export interface SignInOptions {
  /** The iD to sign in as (`login_as`). */
  orcid: string;
  /** Default `/authenticate`. */
  scope?: string;
  /** Default: the starter users file's public client. */
  clientId?: string;
  /** Default: the starter users file's secret. */
  clientSecret?: string;
  /** Must be registered for the client. Default: the starter client's `http://localhost:3000/callback`. */
  redirectUri?: string;
  /** Sent as the OpenID Connect `nonce`. */
  nonce?: string;
}

/** The starter users file's public client, which `signIn` uses unless told otherwise. */
export const STARTER_CLIENT_ID = "APP-ORCIDMOCK000001";
export const STARTER_CLIENT_SECRET = "orcid-mock-secret";
export const STARTER_REDIRECT_URI = "http://localhost:3000/callback";

export interface OrcidMockClientOptions {
  /** Per-request timeout. Default 30 seconds. */
  timeoutMs?: number;
}

/** A request the mock refused, or an answer the helper could not use. */
export class OrcidMockError extends Error {
  override readonly name = "OrcidMockError";
  constructor(
    message: string,
    /** The HTTP status, or 0 when the answer was not an HTTP error (a redirect with no code). */
    readonly status: number,
    /** The response body text, empty when there was none. */
    readonly body: string,
  ) {
    super(message);
  }
}

/**
 * Drives one orcid-mock over HTTP. `baseUrl` is the address the test reaches it at, and for a
 * container the same as its `PUBLIC_BASE_URL`.
 */
export class OrcidMockClient {
  readonly baseUrl: string;
  readonly #timeoutMs: number;

  constructor(baseUrl: string, options: OrcidMockClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** `GET /__admin/health`. */
  health(): Promise<OrcidMockHealth> {
    return this.#json("GET", "/__admin/health");
  }

  /**
   * `POST /__admin/reset`: users, clients, counters, and the clock return to the loaded file, and
   * codes, tokens, and sessions are cleared.
   */
  reset(): Promise<OrcidMockHealth> {
    return this.#json("POST", "/__admin/reset");
  }

  /** `GET /__admin/users`: every user, with minted iDs and put-codes filled in. */
  users(): Promise<OrcidMockUserRecord[]> {
    return this.#json("GET", "/__admin/users");
  }

  /** `GET /__admin/users/{iD}`; an unknown iD throws an `OrcidMockError` with status 404. */
  user(orcid: string): Promise<OrcidMockUserRecord> {
    return this.#json("GET", `/__admin/users/${encodeURIComponent(orcid)}`);
  }

  /** `POST /__admin/users`: create only; an omitted `orcid` mints one, an existing iD is a 409. */
  createUser(user: OrcidMockUser): Promise<OrcidMockUserRecord> {
    return this.#json("POST", "/__admin/users", user);
  }

  /** `PUT /__admin/users/{iD}`: create or replace; the path iD wins. */
  putUser(orcid: string, user: OrcidMockUser): Promise<OrcidMockUserRecord> {
    return this.#json("PUT", `/__admin/users/${encodeURIComponent(orcid)}`, user);
  }

  /** `DELETE /__admin/users/{iD}`; an unknown iD throws an `OrcidMockError` with status 404. */
  async deleteUser(orcid: string): Promise<void> {
    await this.#request("DELETE", `/__admin/users/${encodeURIComponent(orcid)}`);
  }

  /** `PUT /__admin/clients/{client_id}`: register or replace an OAuth client. */
  putClient(
    clientId: string,
    client: OrcidMockClientRegistration,
  ): Promise<OrcidMockClientRegistration> {
    return this.#json("PUT", `/__admin/clients/${encodeURIComponent(clientId)}`, client);
  }

  /**
   * `POST /__admin/clock`: moves the server's clock forward so codes, sessions, and tokens expire
   * without sleeping. Returns the new total offset in milliseconds; `reset()` zeroes it.
   */
  async advanceClock(seconds: number): Promise<number> {
    const body = await this.#json<{ offset_ms: number }>("POST", "/__admin/clock", {
      advance_seconds: seconds,
    });
    return body.offset_ms;
  }

  /**
   * The headless sign-in: `GET /oauth/authorize` with `login_as`, read the code from the
   * `Location` header without following the redirect, then `POST /oauth/token` form-encoded.
   */
  async signIn(options: SignInOptions): Promise<OrcidMockTokenResponse> {
    const clientId = options.clientId ?? STARTER_CLIENT_ID;
    const clientSecret = options.clientSecret ?? STARTER_CLIENT_SECRET;
    const redirectUri = options.redirectUri ?? STARTER_REDIRECT_URI;

    const query = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      scope: options.scope ?? "/authenticate",
      redirect_uri: redirectUri,
      login_as: options.orcid,
    });
    if (options.nonce !== undefined) query.set("nonce", options.nonce);

    const authorize = await this.#fetch(`/oauth/authorize?${query}`, { redirect: "manual" });
    const location = authorize.headers.get("location");
    if (authorize.status !== 302 || location === null) {
      throw new OrcidMockError(
        `GET /oauth/authorize answered ${authorize.status}, not a redirect: ${await authorize.text()}`,
        authorize.status,
        "",
      );
    }
    // A refusal that ORCID sends back to the client carries `error` in the fragment, not a code.
    const target = new URL(location);
    const code = target.searchParams.get("code");
    if (code === null) {
      throw new OrcidMockError(
        `GET /oauth/authorize redirected without a code: ${location}`,
        authorize.status,
        "",
      );
    }

    const token = await this.#fetch("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
    });
    const text = await token.text();
    if (token.status !== 200) {
      throw new OrcidMockError(
        `POST /oauth/token answered ${token.status}: ${text}`,
        token.status,
        text,
      );
    }
    return JSON.parse(text) as OrcidMockTokenResponse;
  }

  #fetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
  }

  async #request(method: string, path: string, body?: unknown): Promise<Response> {
    const response = await this.#fetch(path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new OrcidMockError(
        `${method} ${path} answered ${response.status}: ${text}`,
        response.status,
        text,
      );
    }
    return response;
  }

  async #json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await (await this.#request(method, path, body)).json()) as T;
  }
}
