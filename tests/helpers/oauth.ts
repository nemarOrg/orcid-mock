// Reusable OAuth helpers for the route tests of phases 2, 3, 4, and 7. They drive the real server
// over HTTP, like every test here: `authorizeAs` uses the `login_as` shortcut and a manual
// redirect, and the rest are thin wrappers over `fetch`.
import type { TestServer } from "../harness";

/** The redirect URI both starter clients register (a path prefix of it is also accepted). */
export const REDIRECT_URI = "http://localhost:3000/callback";

export interface TestClient {
  client_id: string;
  client_secret: string;
  redirectUri: string;
}

/** The starter fixture's two clients: a public one (the default) and a member one. */
export const CLIENTS = {
  public: {
    client_id: "APP-ORCIDMOCK000001",
    client_secret: "orcid-mock-secret",
    redirectUri: REDIRECT_URI,
  },
  member: {
    client_id: "APP-ORCIDMOCK000002",
    client_secret: "orcid-mock-secret",
    redirectUri: REDIRECT_URI,
  },
} as const satisfies Record<string, TestClient>;

export type ClientName = keyof typeof CLIENTS;
/** A starter client by name, or any client a test registered through the admin API. */
export type ClientRef = ClientName | TestClient;

export function resolveClient(ref: ClientRef = "public"): TestClient {
  return typeof ref === "string" ? CLIENTS[ref] : ref;
}

/** The iDs of the starter users, keyed by lowercase given name (alder, sennet, briar). */
export async function userIds(server: TestServer): Promise<Record<string, string>> {
  const { body } = await server.admin<Array<{ orcid: string; name: { given_names: string } }>>(
    "GET",
    "/users",
  );
  return Object.fromEntries(body.map((user) => [user.name.given_names.toLowerCase(), user.orcid]));
}

/** `{baseUrl}/oauth/authorize?...`; parameters that are undefined are left out. */
export function authorizeUrl(baseUrl: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) query.set(name, value);
  }
  return `${baseUrl}/oauth/authorize?${query}`;
}

export interface AuthorizeOptions {
  orcid: string;
  scope: string;
  client?: ClientRef;
  state?: string;
  nonce?: string;
  redirectUri?: string;
  prompt?: string;
  /** A `name=value` pair for the Cookie header, as `sessionCookie` returns it. */
  cookie?: string;
}

export interface AuthorizeResult {
  /** The authorization code from the redirect. */
  code: string;
  /** The `state` the redirect carried, decoded, or null if it carried none. */
  state: string | null;
  /** The raw `Location` header. */
  location: string;
  /** The session cookie the response set, as a `name=value` pair for a Cookie header. */
  cookie: string | null;
  response: Response;
}

/** The `name=value` of the session cookie a response set, or null. */
export function sessionCookie(response: Response): string | null {
  const header = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("orcid_mock_session="));
  return header ? (header.split(";")[0] ?? null) : null;
}

/**
 * Signs `orcid` in with the `login_as` shortcut and returns the code the redirect carried.
 * Throws if the answer is not a redirect with a code (use `authorizeUrl` and `fetch` to look at
 * an error).
 */
export async function authorizeAs(
  server: TestServer,
  opts: AuthorizeOptions,
): Promise<AuthorizeResult> {
  const client = resolveClient(opts.client);
  const response = await fetch(
    authorizeUrl(server.baseUrl, {
      client_id: client.client_id,
      response_type: "code",
      scope: opts.scope,
      redirect_uri: opts.redirectUri ?? client.redirectUri,
      state: opts.state,
      nonce: opts.nonce,
      prompt: opts.prompt,
      login_as: opts.orcid,
    }),
    { redirect: "manual", ...(opts.cookie ? { headers: { cookie: opts.cookie } } : {}) },
  );
  const location = response.headers.get("location") ?? "";
  const code = response.status === 302 ? new URL(location).searchParams.get("code") : null;
  if (code === null) {
    throw new Error(`authorize did not issue a code: ${response.status} ${location}`);
  }
  return {
    code,
    state: new URL(location).searchParams.get("state"),
    location,
    cookie: sessionCookie(response),
    response,
  };
}

export interface ParsedForm {
  action: string;
  method: string;
  /** The hidden fields in order, values unescaped. */
  fields: Array<[string, string]>;
  /** The submit button's text, unescaped. */
  button: string;
  /** The submit button's `name` and `value` when it has them (the Deny button does). */
  buttonField: [string, string] | null;
}

function unescapeHtml(text: string): string {
  return text.replace(/&(lt|gt|quot|#39|amp);/g, (_, entity: string) => {
    return { lt: "<", gt: ">", quot: '"', "#39": "'", amp: "&" }[entity] ?? "";
  });
}

/** Reads the `<form>` elements of a page the way a browser would submit them. */
export function parseForms(html: string): ParsedForm[] {
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].map((match) => {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    const attr = (source: string, name: string) =>
      unescapeHtml(new RegExp(`\\b${name}="([^"]*)"`).exec(source)?.[1] ?? "");
    const fields = [...body.matchAll(/<input\b([^>]*)>/g)].map((input): [string, string] => [
      attr(input[1] ?? "", "name"),
      attr(input[1] ?? "", "value"),
    ]);
    const button = /<button\b([^>]*)>([\s\S]*?)<\/button>/.exec(body);
    const buttonName = attr(button?.[1] ?? "", "name");
    return {
      action: attr(attrs, "action"),
      method: attr(attrs, "method"),
      fields,
      button: unescapeHtml(button?.[2] ?? ""),
      buttonField: buttonName === "" ? null : [buttonName, attr(button?.[1] ?? "", "value")],
    };
  });
}

/** Submits a parsed form as a browser would: form-encoded, redirects left for the caller. */
export function submitForm(form: ParsedForm, extra: Array<[string, string]> = []) {
  const fields = [...form.fields, ...(form.buttonField ? [form.buttonField] : []), ...extra];
  return fetch(form.action, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

/** What a token-endpoint call answered: the raw text is kept for key-order assertions. */
export interface TokenReply {
  status: number;
  headers: Headers;
  /** The exact body bytes, as text. */
  text: string;
  /** The parsed JSON body, or null when the body is empty or not JSON. */
  json: Record<string, unknown> | null;
}

/** A successful token response; `name` is absent for client credentials. */
export interface TokenResponse {
  access_token: string;
  token_type: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  name?: string;
  orcid: string | null;
  id_token?: string;
}

/** `Authorization: Basic ...` for a client. */
export function basicAuth(ref: ClientRef = "public"): string {
  const client = resolveClient(ref);
  return `Basic ${btoa(`${client.client_id}:${client.client_secret}`)}`;
}

/** A form-encoded POST; undefined fields are left out. */
export async function postForm(
  server: TestServer,
  path: string,
  fields: Record<string, string | undefined>,
  headers: Record<string, string> = {},
): Promise<TokenReply> {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined) body.set(name, value);
  }
  const response = await fetch(`${server.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
  });
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object") json = parsed as Record<string, unknown>;
  } catch {
    // Not JSON: the 415 page and an empty body.
  }
  return { status: response.status, headers: response.headers, text, json };
}

/** `client_id` and `client_secret` form fields for a client. */
export function clientFields(ref: ClientRef = "public"): Record<string, string> {
  const client = resolveClient(ref);
  return { client_id: client.client_id, client_secret: client.client_secret };
}

/** POST /oauth/token with the client's credentials in the form; `fields` may override them. */
export function tokenRequest(
  server: TestServer,
  fields: Record<string, string | undefined>,
  client: ClientRef = "public",
  headers: Record<string, string> = {},
): Promise<TokenReply> {
  return postForm(server, "/oauth/token", { ...clientFields(client), ...fields }, headers);
}

/** Exchanges an authorization code; the redirect URI defaults to the client's registered one. */
export function exchangeCode(
  server: TestServer,
  opts: { code: string; client?: ClientRef; redirectUri?: string | null },
): Promise<TokenReply> {
  const client = resolveClient(opts.client);
  return tokenRequest(
    server,
    {
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri:
        opts.redirectUri === null ? undefined : (opts.redirectUri ?? client.redirectUri),
    },
    client,
  );
}

/** Signs `orcid` in with `login_as` and exchanges the code; throws unless the answer is a 200. */
export async function obtainToken(
  server: TestServer,
  opts: {
    orcid: string;
    scope: string;
    client?: ClientRef;
    state?: string;
    nonce?: string;
    redirectUri?: string;
  },
): Promise<TokenResponse> {
  const { code } = await authorizeAs(server, opts);
  const reply = await exchangeCode(server, {
    code,
    ...(opts.client === undefined ? {} : { client: opts.client }),
    ...(opts.redirectUri === undefined ? {} : { redirectUri: opts.redirectUri }),
  });
  if (reply.status !== 200 || reply.json === null) {
    throw new Error(`token exchange answered ${reply.status}: ${reply.text}`);
  }
  return reply.json as unknown as TokenResponse;
}

/** The client-credentials grant; `scope` defaults to none, which ORCID treats as /read-public. */
export function clientCredentials(
  server: TestServer,
  opts: { client?: ClientRef; scope?: string } = {},
): Promise<TokenReply> {
  return tokenRequest(server, { grant_type: "client_credentials", scope: opts.scope }, opts.client);
}

/** The refresh-token grant; `extra` carries `scope` or `revoke_old`. */
export function refreshTokens(
  server: TestServer,
  opts: { refreshToken: string; client?: ClientRef; extra?: Record<string, string | undefined> },
): Promise<TokenReply> {
  return tokenRequest(
    server,
    { grant_type: "refresh_token", refresh_token: opts.refreshToken, ...opts.extra },
    opts.client,
  );
}
