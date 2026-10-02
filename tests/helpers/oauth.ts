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
