// The signing key behind every ID token and the JWKS that publishes it.
// The key is generated on first use and kept in the Store, which keeps it across `reset()`, so a
// client that cached the JWKS stays valid. Nothing here runs at module scope: Workers refuse to
// draw random values or generate keys while a module is being evaluated (ADR 0002).
import { randomString } from "../random";
import type { SigningKey, Store } from "../store/types";

const RSA_IMPORT = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const RSA_ALGORITHM = {
  ...RSA_IMPORT,
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
} as const satisfies RsaHashedKeyGenParams;

const KID_PREFIX = "orcid-mock-";
const KID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const KID_RANDOM_LENGTH = 32;

/**
 * ORCID's key ids read `<env>-orcid-org-<32 lowercase alphanumerics>` (observed on orcid.org on
 * 2026-10-01: a production id of that form). The environment part says where a key came from, so
 * orcid-mock's own read `orcid-mock-<32 lowercase alphanumerics>`.
 */
function newKeyId(): string {
  return KID_PREFIX + randomString(KID_ALPHABET, KID_RANDOM_LENGTH);
}

/**
 * A new RSA 2048-bit key pair for RS256, the only algorithm ORCID's discovery document
 * advertises (`id_token_signing_alg_values_supported`) and that its production key uses (a 2048-bit
 * modulus with exponent `AQAB`, observed on orcid.org on 2026-10-01).
 */
async function generateSigningKey(): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey(RSA_ALGORITHM, true, ["sign", "verify"]);
  const [privateJwk, publicJwk] = await Promise.all([
    crypto.subtle.exportKey("jwk", pair.privateKey),
    crypto.subtle.exportKey("jwk", pair.publicKey),
  ]);
  return {
    kid: newKeyId(),
    private_jwk: privateJwk,
    public_jwk: publicJwk,
    created_ms: Date.now(),
  };
}

/**
 * The tenant's signing key: the stored one, else a new one. Two first requests that race each
 * generate a key apiece, and `putSigningKeyIfAbsent` makes one of them the winner for both.
 */
export async function getSigningKey(store: Store): Promise<SigningKey> {
  const existing = await store.getSigningKey();
  if (existing !== null) return existing;
  return await store.putSigningKeyIfAbsent(await generateSigningKey());
}

/** The private half as a Web Crypto key that can sign, for `jose`. */
export function importSigningKey(key: SigningKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", key.private_jwk, RSA_IMPORT, false, ["sign"]);
}
