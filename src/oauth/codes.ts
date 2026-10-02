// Authorization codes: generation and issuing.
import { serverNowMs } from "../clock";
import type { ScopeName, Store, StoredClient } from "../store/types";

/**
 * ORCID documents no lifetime, only single use ("expires upon use", ORCID-Source
 * orcid-api-web/tutorial/get_id.md), so ten minutes is an orcid-mock choice: long enough for a
 * slow test, short enough that the admin clock can expire a code with a small advance.
 */
export const CODE_TTL_MS = 10 * 60 * 1000;

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CODE_LENGTH = 6;

/**
 * Six mixed-case alphanumeric characters (ORCID-Source orcid-api-web/tutorial/get_id.md, "a
 * 6-character authorization code"; the legacy generator drew from the base62 alphabet,
 * orcid-core/.../NamespacedRandomCodeGenerator.java). Bytes that would bias the draw (248 and
 * above, the remainder after four full passes over 62 characters) are discarded.
 */
export function generateCode(): string {
  let code = "";
  const bytes = new Uint8Array(16);
  while (code.length < CODE_LENGTH) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < 248 && code.length < CODE_LENGTH) code += ALPHABET.charAt(byte % 62);
    }
  }
  return code;
}

export interface CodeGrant {
  client: StoredClient;
  orcid: string;
  scopes: ScopeName[];
  /** Exactly as the client sent it: the token endpoint requires the same string back. */
  redirectUri: string;
  nonce: string | null;
  /** Wall-clock epoch milliseconds of the sign-in the code belongs to. */
  authTimeMs: number;
}

/**
 * Stores a code and returns it. `amr` is "pwd" for a member client and absent for a public one,
 * because ORCID returns it only to the Member API (research 5.3, ORCID-Source
 * orcid-web/ORCID_AUTH_WITH_OPENID_CONNECT.md); phase 3 copies it into the ID token.
 */
export async function issueCode(store: Store, grant: CodeGrant): Promise<string> {
  const code = generateCode();
  await store.putCode({
    code,
    client_id: grant.client.client_id,
    orcid: grant.orcid,
    scopes: grant.scopes,
    redirect_uri: grant.redirectUri,
    nonce: grant.nonce,
    auth_time_ms: grant.authTimeMs,
    amr: grant.client.member ? "pwd" : null,
    expires_at_ms: (await serverNowMs(store)) + CODE_TTL_MS,
  });
  return code;
}
