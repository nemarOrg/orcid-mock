import { describe, expect, test } from "bun:test";
import {
  checksumChar,
  formatOrcidId,
  isValidOrcidId,
  MINT_PREFIX,
  mintOrcidId,
} from "../src/orcid-id";

// The three sample iDs listed on ORCID's "Structure of the ORCID Identifier" page.
const SAMPLES = ["0000-0002-1825-0097", "0000-0001-5109-3700", "0000-0002-1694-233X"];

describe("checksum", () => {
  test("the three ORCID sample iDs are valid", () => {
    for (const id of SAMPLES) expect(isValidOrcidId(id)).toBe(true);
  });

  test("the check character is X for a remainder of ten", () => {
    expect(checksumChar("000000021694233")).toBe("X");
    expect(formatOrcidId("000000021694233")).toBe("0000-0002-1694-233X");
  });

  test("every single-digit corruption of every sample is invalid", () => {
    for (const id of SAMPLES) {
      for (let i = 0; i < id.length; i++) {
        const char = id[i] as string;
        if (!/\d/.test(char)) continue;
        for (let d = 0; d <= 9; d++) {
          if (String(d) === char) continue;
          const corrupted = `${id.slice(0, i)}${d}${id.slice(i + 1)}`;
          expect(isValidOrcidId(corrupted)).toBe(false);
        }
      }
    }
  });

  test("a lowercase x is invalid", () => {
    expect(isValidOrcidId("0000-0002-1694-233x")).toBe(false);
  });

  test("a wrong shape is invalid", () => {
    for (const bad of ["", "0000000216942 33X", "0000-0002-1825-009", "0000-0002-1825-00977"]) {
      expect(isValidOrcidId(bad)).toBe(false);
    }
    expect(isValidOrcidId("https://orcid.org/0000-0002-1825-0097")).toBe(false);
  });

  test("checksumChar rejects anything but fifteen digits", () => {
    expect(() => checksumChar("123")).toThrow(RangeError);
  });
});

describe("minting", () => {
  test("1,000 minted iDs are valid, distinct enough, and inside the mint block", () => {
    const seen = new Set<string>();
    for (let n = 1; n <= 1000; n++) {
      const id = mintOrcidId(`seq:${n}`);
      expect(isValidOrcidId(id)).toBe(true);
      expect(id.startsWith("0009-9")).toBe(true);
      expect(id.replaceAll("-", "").startsWith(MINT_PREFIX)).toBe(true);
      seen.add(id);
    }
    expect(seen.size).toBe(1000);
  });

  // These literals are pinned on purpose. Consumers hardcode minted iDs in their own tests, so
  // changing the hash, the seed format, or the mint block breaks them; if one of these fails, that
  // is a breaking change to announce, not a snapshot to refresh.
  test("minted iDs are pinned", () => {
    expect(mintOrcidId("seq:1")).toBe("0009-9507-1056-7754");
    expect(mintOrcidId("seq:2")).toBe("0009-9870-9060-0750");
    expect(mintOrcidId("seq:1", 1)).toBe("0009-9738-5192-4024");
  });

  test("the same seed and attempt give the same iD", () => {
    expect(mintOrcidId("seq:1")).toBe(mintOrcidId("seq:1"));
    expect(mintOrcidId("seq:1", 3)).toBe(mintOrcidId("seq:1", 3));
  });

  test("different attempts and different seeds give different iDs", () => {
    expect(mintOrcidId("seq:1", 0)).not.toBe(mintOrcidId("seq:1", 1));
    expect(mintOrcidId("seq:1")).not.toBe(mintOrcidId("seq:2"));
  });
});
