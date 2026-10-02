// Random strings from a fixed alphabet. Nothing here runs at module scope: Workers refuse to draw
// random values while a module is being evaluated (ADR 0002).

/**
 * `length` characters drawn uniformly from `alphabet` (at most 256 of them) with Web Crypto.
 * A byte at or above the largest multiple of the alphabet's size that fits in 256 would favor the
 * first characters of the alphabet, so such bytes are discarded and redrawn (rejection sampling)
 * instead of reduced with a bare modulo.
 */
export function randomString(alphabet: string, length: number): string {
  if (alphabet.length < 1 || alphabet.length > 256) {
    throw new RangeError("randomString expects an alphabet of 1 to 256 characters");
  }
  const unbiasedLimit = 256 - (256 % alphabet.length);
  // One call may fill at most 65536 bytes, and a few hundred is plenty for any string here.
  const bytes = new Uint8Array(Math.min(length, 256));
  let result = "";
  while (result.length < length) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < unbiasedLimit && result.length < length) {
        result += alphabet.charAt(byte % alphabet.length);
      }
    }
  }
  return result;
}
