// `parseBearerHeader` is a pure function of a header string, so it is tested directly with real
// strings; `tests/record-bearer.test.ts` exercises the same cases over HTTP on real /v3.0 routes.
import { describe, expect, test } from "bun:test";
import { parseBearerHeader } from "../src/oauth/bearer";

describe("parseBearerHeader", () => {
  test("takes the token after a case-insensitive Bearer scheme and trims it", () => {
    expect(parseBearerHeader("Bearer abc")).toBe("abc");
    expect(parseBearerHeader("bearer abc")).toBe("abc");
    expect(parseBearerHeader("BEARER \t abc \t ")).toBe("abc");
    expect(parseBearerHeader("  Bearer abc")).toBe("abc");
    // Anything after the first run of whitespace is the token, inner spaces included.
    expect(parseBearerHeader("Bearer a b")).toBe("a b");
  });

  test("presents nothing without a header, a token, or the Bearer scheme", () => {
    for (const header of [
      undefined,
      "",
      " ",
      "Bearer",
      "Bearer ",
      "Bearer \t ",
      "Basic abc",
      "Bearerx abc",
      "abc",
      "Bearer",
    ]) {
      expect(parseBearerHeader(header)).toBeNull();
    }
  });

  test("a 64 KB run of spaces is answered at once, whatever follows it", () => {
    const spaces = " ".repeat(64 * 1024);
    const started = performance.now();
    expect(parseBearerHeader(`Bearer a${spaces}b`)).toBe(`a${spaces}b`);
    expect(parseBearerHeader(`Bearer${spaces}`)).toBeNull();
    expect(parseBearerHeader(`${spaces}Bearer a`)).toBe("a");
    expect(parseBearerHeader(`Bearer a${spaces}`)).toBe("a");
    // The regular expression this replaced needed about nine seconds for the first of these.
    expect(performance.now() - started).toBeLessThan(250);
  });
});
