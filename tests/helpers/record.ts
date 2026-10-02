// Helpers for the record API tests: they drive the real server over HTTP like every test here.

import { IDS } from "../fixtures/record";
import type { TestServer } from "../harness";

type Reachable = Pick<TestServer, "baseUrl" | "publicBaseUrl">;

export interface RecordReply {
  status: number;
  headers: Headers;
  /** The exact body bytes, as text. */
  text: string;
  /** The parsed JSON body, or undefined when the body is empty or not JSON. */
  json: unknown;
}

export interface RecordRequest {
  /** The `Accept` header; defaults to `application/json`, which is the only one that always works. */
  accept?: string;
  /** Sent as `Authorization: Bearer <token>`. */
  token?: string;
  method?: string;
  headers?: Record<string, string>;
}

async function toReply(response: Response): Promise<RecordReply> {
  const text = await response.text();
  let json: unknown;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

/** `GET {baseUrl}{path}` with `Accept: application/json` unless told otherwise. */
export async function getRecord(
  server: Reachable,
  path: string,
  opts: RecordRequest = {},
): Promise<RecordReply> {
  const headers: Record<string, string> = {
    accept: opts.accept ?? "application/json",
    ...(opts.token === undefined ? {} : { authorization: `Bearer ${opts.token}` }),
    ...opts.headers,
  };
  return toReply(
    await fetch(`${server.baseUrl}${path}`, {
      method: opts.method ?? "GET",
      headers,
      redirect: "manual",
    }),
  );
}

/**
 * A request with exactly the headers given: `fetch` always adds a wildcard `Accept` header, so a
 * request with no `Accept` header at all needs a socket, and so does a `Host` header that is not
 * the server's own (`host`). Speaks HTTP/1.1 with `Connection: close`. `body` follows the headers
 * as written, so the caller sets `Content-Length`.
 */
export async function rawRequest(
  server: Reachable,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  host?: string,
  body = "",
): Promise<RecordReply> {
  const url = new URL(server.baseUrl);
  const lines = [
    `${method} ${path} HTTP/1.1`,
    `Host: ${host ?? url.host}`,
    "Connection: close",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ];
  const chunks: Uint8Array[] = [];
  await new Promise<void>((resolve, reject) => {
    Bun.connect({
      hostname: url.hostname,
      port: Number(url.port),
      socket: {
        open(socket) {
          socket.write(lines.join("\r\n") + body);
        },
        data(_socket, data) {
          chunks.push(new Uint8Array(data));
        },
        close() {
          resolve();
        },
        error(_socket, error) {
          reject(error);
        },
        connectError(_socket, error) {
          reject(error);
        },
      },
    }).catch(reject);
  });
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const raw = new TextDecoder().decode(bytes);
  const split = raw.indexOf("\r\n\r\n");
  const head = raw.slice(0, split).split("\r\n");
  const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head[0] ?? "")?.[1]);
  const responseHeaders = new Headers();
  for (const line of head.slice(1)) {
    const colon = line.indexOf(":");
    responseHeaders.append(line.slice(0, colon), line.slice(colon + 1).trim());
  }
  let text = raw.slice(split + 4);
  if (responseHeaders.get("transfer-encoding") === "chunked") {
    // Decode chunked framing: `<hex size>\r\n<data>\r\n` repeated, ending with a zero chunk.
    let decoded = "";
    let rest = text;
    for (;;) {
      const eol = rest.indexOf("\r\n");
      const size = Number.parseInt(rest.slice(0, eol), 16);
      if (!size) break;
      decoded += rest.slice(eol + 2, eol + 2 + size);
      rest = rest.slice(eol + 2 + size + 2);
    }
    text = decoded;
  }
  let json: unknown;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status, headers: responseHeaders, text, json };
}

/** The six headers every `/v3.0` response carries, errors included. */
export const RECORD_HEADERS = {
  "access-control-allow-origin": "*",
  "cache-control": "no-cache, no-store, max-age=0, must-revalidate",
  pragma: "no-cache",
  expires: "0",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

/** The five keys of an ORCID error body, in ORCID's order. */
export const ERROR_KEYS = [
  "response-code",
  "developer-message",
  "user-message",
  "error-code",
  "more-info",
];

/**
 * The time every item in a freshly loaded fixture is stamped with: the load time, the same for
 * every item and every user, read from Marisol Quenby's public email and checked to be recent.
 * The stamps cannot be written in a fixture, so the tests read this one and expect it everywhere.
 */
export async function loadStamp(server: Reachable): Promise<number> {
  const reply = await getRecord(server, `/v3.0/${IDS.rich}/email`);
  const body = reply.json as { email: Array<{ "created-date": { value: number } }> };
  const stamp = body.email[0]?.["created-date"].value;
  if (stamp === undefined || !Number.isInteger(stamp) || Math.abs(Date.now() - stamp) > 3_600_000) {
    throw new Error(`the load stamp ${stamp} is not a recent epoch time in milliseconds`);
  }
  return stamp;
}
