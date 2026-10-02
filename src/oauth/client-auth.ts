// Client authentication, shared by the token and revoke endpoints.
import type { Context } from "hono";
import type { AppEnv } from "../app";
import { oauthError } from "../errors";
import type { StoredClient } from "../store/types";
import { type Checked, fail } from "./checked";

export type ClientAuth = Checked<{ client: StoredClient }>;

/** The id and secret of a well-formed `Authorization: Basic` header, or null. */
function parseBasic(header: string): { id: string; secret: string } | null {
  const match = /^Basic\s+(\S+)\s*$/i.exec(header.trim());
  if (!match?.[1]) return null;
  let decoded: string;
  try {
    const bytes = Uint8Array.from(atob(match[1]), (char) => char.charCodeAt(0));
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon <= 0) return null;
  // orcid-mock choice: the id and secret are taken as written. RFC 6749 section 2.3.1 says to
  // form-urlencode them before the base64, but curl and most client libraries do not.
  return { id: decoded.slice(0, colon), secret: decoded.slice(colon + 1) };
}

/**
 * Authenticates the client of a token or revoke request.
 * ORCID's registry proxy forwards any non-blank `Authorization` header to its authorization
 * server verbatim, so the header wins over the form fields when present (ORCID-Source
 * orcid-web/.../OauthGenericCallsController.java `handleBasicAuthentication`, research 2.1);
 * one that is not valid Basic credentials fails as a bad client, as a bogus Basic header was
 * observed to on sandbox.orcid.org on 2026-10-01. Otherwise `client_id` and `client_secret` come
 * from the form, and a missing one is a 401 `invalid_request` naming it (SOURCE
 * AuthorizationServerUtil `addToMapOrThrow`, caught by the controller's generic 401).
 */
export async function authenticateClient(
  c: Context<AppEnv>,
  params: URLSearchParams,
): Promise<ClientAuth> {
  const invalidClient = (): ClientAuth =>
    // Observed on sandbox.orcid.org on 2026-10-01: 401, `error_description` before `error`.
    fail(
      oauthError(c, 401, "invalid_client", "Client authentication failed", {
        descriptionFirst: true,
      }),
    );

  let clientId: string | null;
  let secret: string | null;
  const header = c.req.header("authorization");
  if (header !== undefined && header.trim() !== "") {
    const basic = parseBasic(header);
    if (!basic) return invalidClient();
    clientId = basic.id;
    secret = basic.secret;
  } else {
    clientId = params.get("client_id");
    secret = params.get("client_secret");
    if (!clientId) {
      return fail(oauthError(c, 401, "invalid_request", "client_id is required"));
    }
    if (!secret) {
      return fail(oauthError(c, 401, "invalid_request", "client_secret is required"));
    }
  }

  const client = await c.get("deps").store.getClient(clientId);
  if (!client || client.client_secret !== secret) return invalidClient();
  return { ok: true, client };
}
