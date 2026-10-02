// Pure functions with no I/O, tested directly with real inputs.
import { describe, expect, test } from "bun:test";
import { formatScopes, KNOWN_SCOPES, parseScopes, scopeTokens } from "../src/oauth/scopes";

describe("parseScopes", () => {
  test("splits on spaces, which is what both + and %20 decode to", () => {
    // URLSearchParams decodes the way a query parser does: `+` and `%20` both become a space.
    const plus = new URLSearchParams("scope=openid+/authenticate").get("scope");
    const percent = new URLSearchParams("scope=openid%20/authenticate").get("scope");
    expect(parseScopes(plus)).toEqual({ scopes: ["openid", "/authenticate"], unknown: [] });
    expect(parseScopes(percent)).toEqual({ scopes: ["openid", "/authenticate"], unknown: [] });
  });

  test("knows exactly the four ORCID scopes the mock serves", () => {
    expect([...KNOWN_SCOPES].sort()).toEqual([
      "/authenticate",
      "/read-limited",
      "/read-public",
      "openid",
    ]);
  });

  test("keeps request order, drops duplicates, and ignores extra whitespace", () => {
    expect(parseScopes("  /read-limited   openid\t/read-limited\n")).toEqual({
      scopes: ["/read-limited", "openid"],
      unknown: [],
    });
  });

  test("reports unknown tokens apart from the known scopes", () => {
    expect(parseScopes("/authenticate /activities/update openid Openid")).toEqual({
      scopes: ["/authenticate", "openid"],
      unknown: ["/activities/update", "Openid"],
    });
  });

  test("a missing, empty, or blank parameter has no scopes", () => {
    for (const raw of [undefined, null, "", "   "]) {
      expect(parseScopes(raw)).toEqual({ scopes: [], unknown: [] });
    }
  });
});

describe("scopeTokens", () => {
  test("keeps every distinct token, known or not, in request order", () => {
    expect(scopeTokens(" /webhook  openid /webhook\t/read-public ")).toEqual([
      "/webhook",
      "openid",
      "/read-public",
    ]);
    expect(scopeTokens("")).toEqual([]);
  });
});

describe("formatScopes", () => {
  test("joins with single spaces, keeping the leading slash and none on openid", () => {
    expect(formatScopes(["/read-limited", "openid", "/authenticate"])).toBe(
      "/read-limited openid /authenticate",
    );
    expect(formatScopes(["/read-public"])).toBe("/read-public");
    expect(formatScopes([])).toBe("");
  });

  test("takes any iterable, a Set included", () => {
    expect(formatScopes(new Set(["openid" as const, "/authenticate" as const]))).toBe(
      "openid /authenticate",
    );
  });
});
