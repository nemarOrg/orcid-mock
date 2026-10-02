// `randomString` has no HTTP surface of its own (codes and key ids use it), so it is called
// directly with real inputs and the real Web Crypto generator.
import { describe, expect, test } from "bun:test";
import { randomString } from "../src/random";

describe("randomString", () => {
  test("draws only from the alphabet, to the length asked for", () => {
    for (const [alphabet, length] of [
      ["0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ", 6],
      ["0123456789abcdefghijklmnopqrstuvwxyz", 32],
      ["ab", 1000],
      ["x", 5],
    ] as const) {
      const text = randomString(alphabet, length);
      expect(text).toHaveLength(length);
      for (const char of text) expect(alphabet).toContain(char);
    }
    expect(randomString("abc", 0)).toBe("");
  });

  test("two draws differ", () => {
    expect(randomString("0123456789abcdef", 32)).not.toBe(randomString("0123456789abcdef", 32));
  });

  test("an alphabet of no characters, or of more than 256, is a RangeError", () => {
    expect(() => randomString("", 4)).toThrow(RangeError);
    expect(() => randomString("a".repeat(257), 4)).toThrow(RangeError);
  });

  test("a 256-character alphabet needs no rejection and is still read byte for byte", () => {
    const alphabet = Array.from({ length: 256 }, (_, i) => String.fromCharCode(0x100 + i)).join("");
    const text = randomString(alphabet, 1000);
    expect(text).toHaveLength(1000);
  });

  test("every character is as likely as any other, which a bare modulo would not give", () => {
    // 129 characters: a bare `byte % 129` maps two bytes onto each of the first 127 characters
    // and one onto the last two, so those would turn up half as often (about 1000 times in this
    // sample, against 2000 expected). Rejection sampling keeps them level.
    const alphabet = Array.from({ length: 129 }, (_, i) => String.fromCharCode(0x100 + i)).join("");
    const text = randomString(alphabet, 129 * 2000);
    const counts = new Map<string, number>();
    for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
    for (const index of [0, 1, 63, 126, 127, 128]) {
      const count = counts.get(alphabet.charAt(index)) ?? 0;
      expect(count).toBeGreaterThan(1700);
      expect(count).toBeLessThan(2300);
    }
  });
});
