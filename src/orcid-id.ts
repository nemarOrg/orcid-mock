// Open Researcher and Contributor ID (ORCID) iD: structure, checksum, and deterministic minting.
// Portable layer: synchronous and free of Web Crypto, so it can run at any point in a request.

/** The shape of an iD: four blocks of four, the last character a digit or `X`. */
const ORCID_ID_SHAPE = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;
const BASE_DIGITS = /^\d{15}$/;

/**
 * The check character for the first fifteen digits of an iD, ISO/IEC 7064 MOD 11-2.
 * `X` stands for 10.
 * Source: https://support.orcid.org/hc/en-us/articles/360006897674-Structure-of-the-ORCID-Identifier
 */
export function checksumChar(base15: string): string {
  if (!BASE_DIGITS.test(base15)) {
    throw new RangeError("checksumChar expects exactly 15 digits");
  }
  let total = 0;
  for (const char of base15) {
    total = (total + Number(char)) * 2;
  }
  const result = (12 - (total % 11)) % 11;
  return result === 10 ? "X" : String(result);
}

/** True when `s` has the iD shape (uppercase `X` only) and a correct check character. */
export function isValidOrcidId(s: string): boolean {
  if (!ORCID_ID_SHAPE.test(s)) return false;
  const digits = s.replaceAll("-", "");
  return checksumChar(digits.slice(0, 15)) === digits.slice(15);
}

/** Inserts the hyphens and appends the check character: fifteen digits in, an iD out. */
export function formatOrcidId(base15: string): string {
  const check = checksumChar(base15);
  return `${base15.slice(0, 4)}-${base15.slice(4, 8)}-${base15.slice(8, 12)}-${base15.slice(12)}${check}`;
}

/**
 * The first five digits of every minted iD, so minted iDs read `0009-9ddd-dddd-ddd` plus a check.
 * ORCID's support page says it assigns iDs at random from 0000-0001-5000-0007 to
 * 0000-0003-5000-0001 and from 0009-0000-0000-0000 to 0009-0010-0000-0000, and that those blocks
 * avoid numbers ISNI assigns in other ways
 * (https://support.orcid.org/hc/en-us/articles/360006897674-Structure-of-the-ORCID-Identifier).
 * `0009-9...` is above the documented `0009` range. Whether ISNI or ORCID has allocated anything
 * there is unknown, so a minted iD might be somebody's; the residual collision risk is accepted
 * for a test tool (ADR 0003 records the trade-off).
 */
export const MINT_PREFIX = "00099";

/**
 * cyrb53, a 53-bit synchronous string hash by bryc, public domain:
 * https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js
 */
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * A deterministic iD inside the mint block: the same seed and attempt always give the same iD.
 * Callers bump `attempt` when the iD is already taken.
 */
export function mintOrcidId(seed: string, attempt = 0): string {
  const digits = String(cyrb53(`${seed}#${attempt}`) % 10 ** 10).padStart(10, "0");
  return formatOrcidId(`${MINT_PREFIX}${digits}`);
}
