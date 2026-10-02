// Put-codes in a path: ORCID reads them as Java `Long`s, which is more permissive than digits.

const LONG_MIN = -(2n ** 63n);
const LONG_MAX = 2n ** 63n - 1n;

/**
 * Reads `raw` the way `Long.parseLong` and `Long.valueOf` do: an optional sign, then digits, in
 * the range of a signed 64-bit integer; leading zeros are fine (observed on pub.orcid.org/v3.0 on
 * 2026-10-01: `+9543020` and `09543020` both read the work, and `007` reads as 7). Anything else
 * is null, which is a `NumberFormatException` in ORCID: `abc`, `1.5`, an empty string, a number
 * too large for 64 bits.
 */
export function parseJavaLong(raw: string): bigint | null {
  if (!/^[+-]?\d+$/.test(raw)) return null;
  const value = BigInt(raw);
  return value >= LONG_MIN && value <= LONG_MAX ? value : null;
}
