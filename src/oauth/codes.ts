// Authorization codes: generation and issuing.
import { serverNowMs } from "../clock";
import type { ScopeName, Store, StoredClient } from "../store/types";

/**
 * ORCID documents no lifetime, only single use ("The authorization code expires upon use",
 * https://info.orcid.org/documentation/api-tutorials/api-tutorial-get-and-authenticated-orcid-id/),
 * so ten minutes is an orcid-mock choice: long enough for a slow test, short enough that the
 * admin clock can expire a code with a small advance.
 */
export const CODE_TTL_MS = 10 * 60 * 1000;

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CODE_LENGTH = 6;
// Bytes at or above this would favor the first characters of the alphabet, so they are discarded.
const UNBIASED_BYTE_LIMIT = 256 - (256 % ALPHABET.length);

/**
 * Six mixed-case alphanumeric characters: ORCID's tutorial says "a 6-character authorization
 * code" (https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-api-web/tutorial/get_id.md#L33),
 * and the legacy generator (removed upstream) drew from the base62 alphabet:
 * https://github.com/ORCID/ORCID-Source/blob/7eeb1e7709760f328f5d3f72ebf2629f0a5d54c9/orcid-core/src/main/java/org/orcid/core/oauth/service/NamespacedRandomCodeGenerator.java#L14-L15
 */
export function generateCode(): string {
  let code = "";
  const bytes = new Uint8Array(16);
  while (code.length < CODE_LENGTH) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < UNBIASED_BYTE_LIMIT && code.length < CODE_LENGTH) {
        code += ALPHABET.charAt(byte % ALPHABET.length);
      }
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
 * Stores a code and returns it. `amr` is "pwd" for a member client and null for a public one,
 * because ORCID returns it only to the Member API:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-web/ORCID_AUTH_WITH_OPENID_CONNECT.md#L20
 * It is stored on the code, not on the token record: the authorization-code grant reads it from
 * the consumed code and passes it to `buildTokenResponse`, which is where an ID token gets its
 * `amr` claim.
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
